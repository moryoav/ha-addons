const { installLibsignalLogFilter } = require("./libsignal-log-filter");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const { createWebUiApp, INGRESS_PORT } = require("./webui");

var logger = require("log4js").getLogger();
logger.level = "info";
installLibsignalLogFilter({ logger });

const { WhatsappClient } = require("./whatsapp");

var qrimage = require("qr-image");

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const clients = {};
const clientStates = {};

const currentIsoTime = () => new Date().toISOString();

const setClientState = (key, state) => {
  clientStates[key] = {
    clientId: key,
    ...clientStates[key],
    ...state,
    updatedAt: currentIsoTime(),
  };
};

const createQrDataUrl = (qr) =>
  `data:image/png;base64,${qrimage
    .imageSync(qr, { type: "png" })
    .toString("base64")}`;

const summarizeId = (id) => {
  if (!id) return undefined;
  const value = id.toString();
  return value.length <= 10
    ? value
    : `${value.slice(0, 6)}...${value.slice(-4)}`;
};

const summarizeJid = (jid) => {
  if (!jid) return undefined;
  const value = jid.toString();
  const server = value.includes("@") ? value.split("@").pop() : value;
  return `***@${server}`;
};

const summarizeMessageDebug = (msg) => ({
  hasMessage: msg.hasMessage,
  fromMe: msg.fromMe,
  type: msg.type,
  messageId: summarizeId(msg.messageId),
  remoteJid: summarizeJid(msg.remoteJid),
  participant: summarizeJid(msg.participant),
  messageStubType: msg.messageStubType,
  messageTimestamp: msg.messageTimestamp,
});

const onReady = (key) => {
  setClientState(key, {
    state: "connected",
    connectedAt: currentIsoTime(),
    disconnectedAt: null,
    lastErrorCode: null,
    qrDataUrl: null,
  });
  logger.info(key, "client is ready.");
  axios.post(
    "http://supervisor/core/api/services/persistent_notification/dismiss",
    {
      notification_id: `whatsapp_addon_qrcode_${key}`,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
      },
    }
  );
};

const onQr = (qr, key) => {
  logger.info(
    key,
    "require authentication over QRCode, please see your notifications..."
  );

  try {
    const qrDataUrl = createQrDataUrl(qr);
    setClientState(key, {
      state: "pairing",
      lastQrAt: currentIsoTime(),
      qrDataUrl,
    });

    axios.post(
      "http://supervisor/core/api/services/persistent_notification/create",
      {
        title: `Whatsapp QRCode (${key})`,
        message: `Please scan the following QRCode for **${key}** client... ![QRCode](${qrDataUrl})`,
        notification_id: `whatsapp_addon_qrcode_${key}`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
        },
      }
    );
  } catch (error) {
    logger.error("Failed to generate WhatsApp QR code image.", {
      clientId: key,
      error: error?.message,
    });
  }
};

const onDisconnected = (statusCode, key) => {
  setClientState(key, {
    state: "reconnecting",
    disconnectedAt: currentIsoTime(),
    lastErrorCode: statusCode || null,
    qrDataUrl: null,
  });
};

const onMsg = (msg, key) => {
  axios.post(
    "http://supervisor/core/api/events/new_whatsapp_message",
    { clientId: key, ...msg },
    {
      headers: {
        Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
      },
    }
  )
    .then(() => {
      logger.info("New WhatsApp message event fired.", {
        clientId: key,
        type: msg.type,
        messageId: summarizeId(msg?.key?.id),
        remoteJid: summarizeJid(msg?.key?.remoteJid),
      });
    })
    .catch((error) => {
      logger.error("Failed to fire new WhatsApp message event.", {
        clientId: key,
        messageId: summarizeId(msg?.key?.id),
        status: error?.response?.status,
        error: error?.message,
      });
    });
};

const onMsgUpsert = (upsert, key) => {
  logger.info("WhatsApp messages.upsert received.", {
    clientId: key,
    count: upsert.count,
    type: upsert.type,
    requestId: summarizeId(upsert.requestId),
    messages: upsert.messages.map(summarizeMessageDebug),
  });
};

const onIgnoredMsg = (ignored, key) => {
  logger.info("WhatsApp message ignored before Home Assistant event.", {
    clientId: key,
    reason: ignored.reason,
    message: summarizeMessageDebug(ignored.message),
  });
};

const onDuplicateMsg = (duplicate, key) => {
  logger.info("Duplicate WhatsApp message dropped.", {
    clientId: key,
    messageId: duplicate.keyId,
    type: duplicate.type,
    firstRemoteJid: summarizeJid(duplicate.firstRemoteJid),
    duplicateRemoteJid: summarizeJid(duplicate.duplicateRemoteJid),
    firstSeenAt: duplicate.firstSeenAt,
    duplicateSeenAt: duplicate.duplicateSeenAt,
    ageMs: duplicate.ageMs,
  });
};

const onDedupeCollision = (collision, key) => {
  logger.warn("WhatsApp message dedupe key collision; message allowed.", {
    clientId: key,
    messageId: collision.keyId,
    type: collision.type,
    firstRemoteJid: summarizeJid(collision.firstRemoteJid),
    remoteJid: summarizeJid(collision.remoteJid),
    firstSeenAt: collision.firstSeenAt,
    collisionAt: collision.collisionAt,
    ageMs: collision.ageMs,
    firstPayloadHash: collision.firstPayloadHash,
    payloadHash: collision.payloadHash,
  });
};

const onPresenceUpdate = (presence, key) => {
  axios.post(
    "http://supervisor/core/api/events/whatsapp_presence_update",
    { clientId: key, ...presence },
    {
      headers: {
        Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
      },
    }
  );
  logger.debug(`New presence event fired from ${key}.`);
};

const registerDiscovery = () => {
  const hostname = process.env.HOSTNAME;
  const addonUrl = `http://${hostname || "whatsapp-addon"}:${port}`;

  axios
    .post(
      "http://supervisor/discovery",
      {
        service: "whatsapp",
        config: {
          url: addonUrl,
          host: hostname,
          port,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
        },
      }
    )
    .then(() => {
      logger.info("Registered WhatsApp add-on discovery.", { url: addonUrl });
    })
    .catch((error) => {
      const status = error?.response?.status;
      const message =
        status === 403
          ? "Supervisor denied WhatsApp add-on discovery registration. The add-on metadata must declare discovery service 'whatsapp'."
          : "Failed to register WhatsApp add-on discovery.";
      logger.warn(message, {
        service: "whatsapp",
        status: error?.response?.status,
        error: error?.message,
      });
    });
};

const onLogout = async (key) => {
  setClientState(key, {
    state: "logged_out",
    disconnectedAt: currentIsoTime(),
    qrDataUrl: null,
  });
  logger.info(`Client ${key} was logged out. Restarting...`);
  fs.rm(`/data/${key}`, { recursive: true });

  init(key);
};

const init = (key) => {
  setClientState(key, {
    state: "connecting",
    qrDataUrl: null,
  });
  clients[key] = new WhatsappClient({ path: `/data/${key}` });

  clients[key].on("restart", () => {
    setClientState(key, { state: "restarting" });
    logger.debug(`${key} client restarting...`);
  });
  clients[key].on("qr", (qr) => onQr(qr, key));
  clients[key].on("ready", () => onReady(key));
  clients[key].on("disconnected", (statusCode) =>
    onDisconnected(statusCode, key)
  );
  clients[key].on("msg", (msg) => onMsg(msg, key));
  clients[key].on("msg_upsert", (upsert) => onMsgUpsert(upsert, key));
  clients[key].on("msg_ignored", (ignored) => onIgnoredMsg(ignored, key));
  clients[key].on("msg_duplicate", (duplicate) => onDuplicateMsg(duplicate, key));
  clients[key].on("msg_dedupe_collision", (collision) =>
    onDedupeCollision(collision, key)
  );
  clients[key].on("logout", () => onLogout(key));
  clients[key].on("presence_update", (presence) =>
    onPresenceUpdate(presence, key)
  );
};

fs.readFile("data/options.json", function (error, content) {
  var options = JSON.parse(content);

  options.clients.forEach((key) => {
    init(key);
  });

  app.get("/health", (req, res) => {
    const clientIds = Object.keys(clients);
    res.json({
      status: "ok",
      client_count: clientIds.length,
      clients: clientIds,
    });
  });

  app.post("/sendMessage", (req, res) => {
    const message = req.body;
    if (message.hasOwnProperty("clientId")) {
      if (clients.hasOwnProperty(message.clientId)) {
        const wapp = clients[message.clientId];
        wapp
          .sendMessage(message.to, message.body, message.options)
          .then((sentMsg) => {
            res.json(sentMsg);
            logger.debug("Message successfully sended from addon.");
          })
          .catch((error) => {
            res.status(500).json({ error: error.message });
            logger.error(error.message);
          });
      } else {
        logger.error("Error in sending message. Client ID not found.");
        res.send("KO");
      }
    } else {
      logger.error("Error in sending message. Please specify client ID.");
      res.send("KO");
    }
  });

  app.post("/setStatus", (req, res) => {
    const status = req.body.status;
    if (req.body.hasOwnProperty("clientId")) {
      if (clients.hasOwnProperty(req.body.clientId)) {
        const wapp = clients[req.body.clientId];

        wapp
          .updateProfileStatus(status)
          .then(() => {
            res.send("OK");
          })
          .catch((error) => {
            res.send("KO");
            logger.error(error.message);
          });
      } else {
        logger.error("Error in set status. Client ID not found.");
        res.send("KO");
      }
    } else {
      logger.error("Error in set status. Please specify client ID.");
      res.send("KO");
    }
  });

  app.post("/presenceSubscribe", (req, res) => {
    const request = req.body;

    if (req.body.hasOwnProperty("clientId")) {
      if (clients.hasOwnProperty(req.body.clientId)) {
        const wapp = clients[req.body.clientId];

        wapp
          .presenceSubscribe(request.userId)
          .then(() => {
            res.send("OK");
          })
          .catch((error) => {
            res.send("KO");
            logger.error(error.message);
          });
      } else {
        logger.error("Error in subscribe presence. Client ID not found.");
        res.send("KO");
      }
    } else {
      logger.error("Error in subscribe presence. Please specify client ID.");
      res.send("KO");
    }
  });

  app.post("/sendPresenceUpdate", (req, res) => {
    const request = req.body;

    if (req.body.hasOwnProperty("clientId")) {
      if (clients.hasOwnProperty(req.body.clientId)) {
        const wapp = clients[req.body.clientId];

        wapp
          .sendPresenceUpdate(request.type, request.to)
          .then(() => {
            res.send("OK");
          })
          .catch((error) => {
            res.send("KO");
            logger.error(error.message);
          });
      } else {
        logger.error("Error in presence update. Client ID not found.");
        res.send("KO");
      }
    } else {
      logger.error("Error in presence update. Please specify client ID.");
      res.send("KO");
    }
  });

  app.post("/readMessages", (req, res) => {
    if (!req.body.clientId || !clients.hasOwnProperty(req.body.clientId)) {
      logger.error("Error in read messages: Missing or invalid clientId");
      return res.status(400).send("KO");
    }
  
    const wapp = clients[req.body.clientId];
  
    // We expect req.body.body to contain { keys: { id, remoteJid, fromMe } }
    if (!req.body.body || !req.body.body.keys) {
      logger.error("Error in read messages: 'body.keys' is missing");
      return res.status(400).send("KO");
    }
  
    // Because Baileys readMessages() takes an array of keys, wrap your single object in [ ... ]:
    const singleKeyObject = req.body.body.keys;
    const keysArray = [ singleKeyObject ];
  
    wapp.readMessages(keysArray)
      .then(() => {
        res.send("OK");
        logger.debug("Messages marked as read.");
      })
      .catch((error) => {
        res.status(500).json({ error: error.message });
        logger.error(error.message);
      });
  });


  
  app.post("/sendInfinityPresenceUpdate", (req, res) => {
    const request = req.body;

    if (req.body.hasOwnProperty("clientId")) {
      if (clients.hasOwnProperty(req.body.clientId)) {
        const wapp = clients[req.body.clientId];

        wapp
          .setSendPresenceUpdateInterval(request.type, request.to)
          .then(() => {
            res.send("OK");
          })
          .catch((error) => {
            res.send("KO");
            logger.error(error.message);
          });
      } else {
        logger.error("Error in presence update. Client ID not found.");
        res.send("KO");
      }
    } else {
      logger.error("Error in presence update. Please specify client ID.");
      res.send("KO");
    }
  });

  app.listen(port, () => {
    logger.info(`Whatsapp Addon started.`);
    registerDiscovery();
  });

  createWebUiApp({ clients, clientStates }).listen(INGRESS_PORT, () => {
    logger.info(`Whatsapp Addon ingress web UI started.`);
  });
});
