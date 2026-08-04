const crypto = require("crypto");
const fs = require("fs");

const axios = require("axios");
const qrimage = require("qr-image");

const { createApiApp } = require("./api");
const { createWebUiApp, INGRESS_PORT } = require("./webui");
const { WhatsappClient } = require("./whatsapp");
const {
  RequestValidationError,
  normalizeConfiguredClientIds,
  requirePlainObject,
  resolveSessionPath,
} = require("./validation");

const API_PORT = 3000;
const DATA_ROOT = "/data";
const OPTIONS_PATH = "/data/options.json";
const PROCESS_LOG_KEY = crypto.randomBytes(32);

const currentIsoTime = () => new Date().toISOString();

const fingerprint = (value, key = PROCESS_LOG_KEY) => {
  if (value === undefined || value === null || value === "") return undefined;
  return `hmac:${crypto
    .createHmac("sha256", key)
    .update(String(value))
    .digest("hex")
    .slice(0, 12)}`;
};

const safeHttpStatus = (error) => {
  const status = error?.response?.status;
  return Number.isInteger(status) ? status : undefined;
};

const safeUpstreamCode = (error) => {
  const code = error?.upstreamCode;
  return Number.isInteger(code) || code === "malformed_response"
    ? code
    : undefined;
};

const normalizeApiToken = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[-A-Za-z0-9._~+/]+=*$/.test(value)
  ) {
    throw new RequestValidationError(
      "api_token must be empty or a bearer-safe token of at most 512 characters."
    );
  }

  return value;
};

const parseOptions = (content) => {
  let options;
  try {
    options = JSON.parse(content);
  } catch {
    throw new RequestValidationError("options.json must contain valid JSON.");
  }

  requirePlainObject(options, "options");
  return {
    clientIds: normalizeConfiguredClientIds(options.clients),
    apiToken: normalizeApiToken(options.api_token),
  };
};

const loadOptions = async (
  optionsPath = OPTIONS_PATH,
  fsPromises = fs.promises
) => parseOptions(await fsPromises.readFile(optionsPath, "utf8"));

const createQrDataUrl = (qr) =>
  `data:image/png;base64,${qrimage
    .imageSync(qr, { type: "png" })
    .toString("base64")}`;

const summarizeMessageDebug = (message, fingerprintValue = fingerprint) => ({
  hasMessage: message?.hasMessage,
  fromMe: message?.fromMe,
  type: message?.type,
  messageRef: fingerprintValue(message?.messageId),
  chatRef: fingerprintValue(message?.remoteJid),
  participantRef: fingerprintValue(message?.participant),
  messageStubType: message?.messageStubType,
  messageTimestamp: message?.messageTimestamp,
});

const listen = (app, port) =>
  new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.once("error", reject);
  });

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const removeSessionDirectory = async ({
  dataRoot = DATA_ROOT,
  clientId,
  fsPromises = fs.promises,
}) => {
  const sessionPath = resolveSessionPath(dataRoot, clientId);
  await fsPromises.rm(sessionPath, { recursive: true, force: true });
};

const createAddonRuntime = ({
  clientIds,
  apiToken,
  dataRoot = DATA_ROOT,
  logger = console,
  clientFactory = (options) => new WhatsappClient(options),
  fsPromises = fs.promises,
  httpClient = axios,
  supervisorToken = process.env.SUPERVISOR_TOKEN,
  hostname = process.env.HOSTNAME,
  apiPort = API_PORT,
  fingerprintKey = PROCESS_LOG_KEY,
} = {}) => {
  const validatedClientIds = normalizeConfiguredClientIds(clientIds);
  const clients = Object.create(null);
  const clientStates = Object.create(null);
  const logoutTasks = new Map();
  const logRef = (value) => fingerprint(value, fingerprintKey);

  const supervisorHeaders = {
    Authorization: `Bearer ${supervisorToken || ""}`,
  };

  const setClientState = (clientId, state) => {
    clientStates[clientId] = {
      ...clientStates[clientId],
      ...state,
      updatedAt: currentIsoTime(),
    };
  };

  const postSupervisor = async (path, payload, operation) => {
    try {
      await httpClient.post(`http://supervisor${path}`, payload, {
        headers: supervisorHeaders,
      });
      return true;
    } catch (error) {
      logger.warn?.(`Supervisor ${operation} failed.`, {
        status: safeHttpStatus(error),
      });
      return false;
    }
  };

  const onReady = (clientId) => {
    setClientState(clientId, {
      state: "connected",
      connectedAt: currentIsoTime(),
      disconnectedAt: null,
      lastErrorCode: null,
      qrDataUrl: null,
    });
    logger.info?.("WhatsApp client connected.", {
      clientRef: logRef(clientId),
    });
    void postSupervisor(
      "/core/api/services/persistent_notification/dismiss",
      { notification_id: `whatsapp_addon_qrcode_${clientId}` },
      "notification dismissal"
    );
  };

  const onQr = (qr, clientId) => {
    logger.info?.("WhatsApp client requires QR pairing.", {
      clientRef: logRef(clientId),
    });

    try {
      const qrDataUrl = createQrDataUrl(qr);
      setClientState(clientId, {
        state: "pairing",
        lastQrAt: currentIsoTime(),
        qrDataUrl,
      });

      void postSupervisor(
        "/core/api/services/persistent_notification/create",
        {
          title: `Whatsapp QRCode (${clientId})`,
          message: `Please scan the following QRCode for **${clientId}** client... ![QRCode](${qrDataUrl})`,
          notification_id: `whatsapp_addon_qrcode_${clientId}`,
        },
        "pairing notification"
      );
    } catch {
      logger.error?.("WhatsApp QR image generation failed.", {
        clientRef: logRef(clientId),
      });
    }
  };

  const onDisconnected = (statusCode, clientId) => {
    setClientState(clientId, {
      state: "reconnecting",
      disconnectedAt: currentIsoTime(),
      lastErrorCode: Number.isInteger(statusCode) ? statusCode : null,
      qrDataUrl: null,
    });
  };

  const onClientError = (error, clientId) => {
    logger.warn?.("WhatsApp client operation failed.", {
      clientRef: logRef(clientId),
      upstreamCode: safeUpstreamCode(error),
    });
  };

  const onMsg = (message, clientId) => {
    void postSupervisor(
      "/core/api/events/new_whatsapp_message",
      { clientId, ...message },
      "message event delivery"
    ).then((delivered) => {
      if (!delivered) return;
      logger.info?.("WhatsApp message event delivered.", {
        clientRef: logRef(clientId),
        type: message.type,
        messageRef: logRef(message?.key?.id),
        chatRef: logRef(message?.key?.remoteJid),
      });
    });
  };

  const onMsgUpsert = (upsert, clientId) => {
    logger.info?.("WhatsApp messages received.", {
      clientRef: logRef(clientId),
      count: upsert.count,
      type: upsert.type,
      requestRef: logRef(upsert.requestId),
      messages: (upsert.messages || []).map((message) =>
        summarizeMessageDebug(message, logRef)
      ),
    });
  };

  const onIgnoredMsg = (ignored, clientId) => {
    logger.info?.("WhatsApp message ignored before event delivery.", {
      clientRef: logRef(clientId),
      reason: ignored.reason,
      message: summarizeMessageDebug(ignored.message, logRef),
    });
  };

  const onDuplicateMsg = (duplicate, clientId) => {
    logger.info?.("Duplicate WhatsApp message dropped.", {
      clientRef: logRef(clientId),
      messageRef: logRef(duplicate.keyId),
      type: duplicate.type,
      firstChatRef: logRef(duplicate.firstRemoteJid),
      duplicateChatRef: logRef(duplicate.duplicateRemoteJid),
      firstSeenAt: duplicate.firstSeenAt,
      duplicateSeenAt: duplicate.duplicateSeenAt,
      ageMs: duplicate.ageMs,
    });
  };

  const onDedupeCollision = (collision, clientId) => {
    logger.warn?.("WhatsApp message dedupe collision; message allowed.", {
      clientRef: logRef(clientId),
      messageRef: logRef(collision.keyId),
      type: collision.type,
      firstChatRef: logRef(collision.firstRemoteJid),
      chatRef: logRef(collision.remoteJid),
      firstSeenAt: collision.firstSeenAt,
      collisionAt: collision.collisionAt,
      ageMs: collision.ageMs,
    });
  };

  const onPresenceUpdate = (presence, clientId) => {
    void postSupervisor(
      "/core/api/events/whatsapp_presence_update",
      { clientId, ...presence },
      "presence event delivery"
    );
  };

  const initClient = (clientId) => {
    const sessionPath = resolveSessionPath(dataRoot, clientId);
    setClientState(clientId, { state: "connecting", qrDataUrl: null });

    const client = clientFactory({ path: sessionPath });
    clients[clientId] = client;

    client.on("restart", () => {
      setClientState(clientId, { state: "restarting" });
      logger.debug?.("WhatsApp client restarting.", {
        clientRef: logRef(clientId),
      });
    });
    client.on("qr", (qr) => onQr(qr, clientId));
    client.on("ready", () => onReady(clientId));
    client.on("disconnected", (statusCode) =>
      onDisconnected(statusCode, clientId)
    );
    client.on("client_error", (error) => onClientError(error, clientId));
    client.on("msg", (message) => onMsg(message, clientId));
    client.on("msg_upsert", (upsert) => onMsgUpsert(upsert, clientId));
    client.on("msg_ignored", (ignored) => onIgnoredMsg(ignored, clientId));
    client.on("msg_duplicate", (duplicate) =>
      onDuplicateMsg(duplicate, clientId)
    );
    client.on("msg_dedupe_collision", (collision) =>
      onDedupeCollision(collision, clientId)
    );
    client.on("presence_update", (presence) =>
      onPresenceUpdate(presence, clientId)
    );
    client.on("logout", () => {
      if (logoutTasks.has(clientId)) return;

      const task = (async () => {
        setClientState(clientId, {
          state: "logged_out",
          disconnectedAt: currentIsoTime(),
          qrDataUrl: null,
        });
        logger.info?.("WhatsApp client logged out; resetting session.", {
          clientRef: logRef(clientId),
        });

        const oldClient = clients[clientId];
        oldClient?.removeAllListeners?.();
        delete clients[clientId];
        await removeSessionDirectory({ dataRoot, clientId, fsPromises });
        initClient(clientId);
      })()
        .catch(() => {
          setClientState(clientId, { state: "disconnected" });
          logger.error?.("WhatsApp session reset failed.", {
            clientRef: logRef(clientId),
          });
        })
        .finally(() => logoutTasks.delete(clientId));

      logoutTasks.set(clientId, task);
    });

    return client;
  };

  for (const clientId of validatedClientIds) initClient(clientId);

  const registerDiscovery = async () => {
    const addonUrl = `http://${hostname || "whatsapp-addon"}:${apiPort}`;
    const config = {
      url: addonUrl,
      host: hostname,
      port: apiPort,
    };
    if (apiToken) config.api_token = apiToken;

    const registered = await postSupervisor(
      "/discovery",
      { service: "whatsapp", config },
      "discovery registration"
    );
    if (registered) logger.info?.("WhatsApp add-on discovery registered.");
  };

  return {
    apiToken,
    clientStates,
    clients,
    initClient,
    logoutTasks,
    registerDiscovery,
  };
};

const startAddon = async ({
  optionsPath = OPTIONS_PATH,
  dataRoot = DATA_ROOT,
  apiPort = API_PORT,
  ingressPort = INGRESS_PORT,
  logger = console,
  optionsLoader = loadOptions,
  listenFn = listen,
  closeServerFn = closeServer,
  ...runtimeOptions
} = {}) => {
  const { clientIds, apiToken } = await optionsLoader(optionsPath);
  const runtime = createAddonRuntime({
    clientIds,
    apiToken,
    dataRoot,
    apiPort,
    logger,
    ...runtimeOptions,
  });

  const apiApp = createApiApp({
    clients: runtime.clients,
    logger,
    sharedSecret: apiToken,
  });
  const webUiApp = createWebUiApp({
    clients: runtime.clients,
    clientStates: runtime.clientStates,
  });

  let apiServer;
  let webUiServer;
  try {
    apiServer = await listenFn(apiApp, apiPort);
    webUiServer = await listenFn(webUiApp, ingressPort);
  } catch (error) {
    await Promise.allSettled(
      Object.values(runtime.clients).map((client) => client.disconnect?.())
    );
    if (apiServer) await closeServerFn(apiServer);
    throw error;
  }
  logger.info?.("WhatsApp add-on API started.");
  logger.info?.("WhatsApp add-on ingress UI started.");
  await runtime.registerDiscovery();

  return {
    ...runtime,
    apiApp,
    apiServer,
    webUiApp,
    webUiServer,
    close: async () => {
      await Promise.allSettled(
        Object.values(runtime.clients).map((client) => client.disconnect?.())
      );
      await Promise.all([
        closeServerFn(apiServer),
        closeServerFn(webUiServer),
      ]);
    },
  };
};

module.exports = {
  API_PORT,
  DATA_ROOT,
  OPTIONS_PATH,
  createAddonRuntime,
  fingerprint,
  loadOptions,
  normalizeApiToken,
  parseOptions,
  removeSessionDirectory,
  startAddon,
  summarizeMessageDebug,
};
