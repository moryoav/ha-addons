const EventEmitter = require("eventemitter2");

const makeWASocket = require("./Baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("./Baileys");
const { MessageDedupe } = require("./message-dedupe");

const MessageType = {
  text: "conversation",
  location: "locationMessage",
  liveLocation: "liveLocationMessage",
  image: "imageMessage",
  video: "videoMessage",
  document: "documentMessage",
  contact: "contactMessage",
};

class WhatsappClient extends EventEmitter {
  #conn;
  #path;
  #refreshInterval;
  #sendPresenceUpdateInterval;
  #timeout;
  #attempts;
  #messageDedupe;
  #offline;
  #refreshMs;

  #status = {
    attempt: 0,
    connected: false,
    disconnected: false,
    reconnecting: false,
  };

  #toMilliseconds = (hrs, min, sec) => (hrs * 60 * 60 + min * 60 + sec) * 1000;

  constructor({
    path,
    timeout = 1e3,
    attempts = Infinity,
    offline = true,
    refreshMs,
  }) {
    super();
    this.#path = path;
    this.#timeout = timeout;
    this.#attempts = attempts;
    this.#offline = offline;
    this.#refreshMs = refreshMs || this.#toMilliseconds(6, 0, 0);
    this.#messageDedupe = new MessageDedupe();
    this.connect();
  }

  connect = async () => {
    if (this.#status.connected) return;

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(this.#path);

    this.#conn = makeWASocket({
      version,
      auth: state,
      syncFullHistory: false,
      markOnlineOnConnect: !this.#offline,
      logger: require("pino")({ level: "silent" }),
      generateHighQualityLinkPreview: true,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      defaultQueryTimeoutMs: undefined,
    });

    this.#conn.ev.on("creds.update", (state) => {
      if (state.me) {
        this.emit("pair", {
          phone: state.me.id.split(":")[0],
          name: state.me.name,
        });
      }

      saveCreds(state);
    });

    this.#conn.ev.on("connection.update", this.#onConnectionUpdate);
  };

  disconnect = (reconnect) => {
    if (this.#status.disconnected) return;

    this.#status.connected = false;
    this.#status.disconnected = !reconnect;
    this.#status.reconnecting = !!reconnect;

    return this.#conn.end();
  };

  restart = () => {
    this.emit("restart");
    return this.disconnect(true);
  };

  #toId = (phone) => {
    phone = phone.toString().trim();
    if (!phone) throw new Error("Invalid phone");

    return `${phone.replace("+", "")}${
      !phone.endsWith("@s.whatsapp.net") &&
      !phone.endsWith("@g.us") &&
      !phone.endsWith("@broadcast") &&
      !phone.endsWith("@lid")
        ? "@s.whatsapp.net"
        : ""
    }`;
  };

  #isDirectJid = (phone) => {
    phone = phone.toString();
    return (
      phone.endsWith("@s.whatsapp.net") ||
      phone.endsWith("@g.us") ||
      phone.endsWith("@broadcast") ||
      phone.endsWith("@lid")
    );
  };

  #getErrorCode = (err) =>
    err?.output?.payload?.statusCode ??
    err?.output?.statusCode ??
    err?.statusCode ??
    err?.message ??
    "unknown";

  #getMessageType = (msg) => {
    if (!msg?.message) return undefined;
    return Object.keys(msg.message).find((key) => key !== "messageContextInfo");
  };

  #summarizeMessage = (msg) => ({
    hasMessage: !!msg?.message,
    fromMe: !!msg?.key?.fromMe,
    messageId: msg?.key?.id,
    remoteJid: msg?.key?.remoteJid,
    participant: msg?.key?.participant,
    type: this.#getMessageType(msg),
    messageStubType: msg?.messageStubType,
    messageTimestamp: msg?.messageTimestamp,
  });

  #reconnect = () => {
    if (this.#status.attempt++ > this.#attempts || this.#status.disconnected) {
      this.#status.reconnecting = false;
      this.#status.disconnected = true;
      return;
    }

    setTimeout(this.connect, this.#timeout);
  };

  #onConnectionUpdate = (event) => {
    if (event.qr) this.#onQr(event.qr);
    if (event.connection === "open") this.#onConnected(event);
    else if (event.connection === "close") this.#onDisconnected(event);
  };

  #onQr = (qr) => {
    this.emit("qr", qr);
  };

  #onConnected = (event) => {
    this.#status.attempt = 0;
    this.#status.connected = true;
    this.#status.disconnected = false;
    this.#status.reconnecting = false;

    this.#refreshInterval = setInterval(() => this.restart(), this.#refreshMs);
    if (this.#offline) this.setSendPresenceUpdateInterval("unavailable");

    this.#conn.ev.on("messages.upsert", async ({ messages, type, requestId }) => {
      this.emit("msg_upsert", {
        count: messages?.length || 0,
        type,
        requestId,
        messages: (messages || []).map((msg) => this.#summarizeMessage(msg)),
      });

      for (const msg of messages || []) {
        if (!msg?.message) {
          this.emit("msg_ignored", {
            reason: "missing_message",
            message: this.#summarizeMessage(msg),
          });
          continue;
        }

        if (msg.key?.fromMe) {
          this.emit("msg_ignored", {
            reason: "from_me",
            message: this.#summarizeMessage(msg),
          });
          continue;
        }

        delete msg.message.messageContextInfo;
        const messageType = this.#getMessageType(msg);

        if (!messageType) {
          this.emit("msg_ignored", {
            reason: "missing_message_type",
            message: this.#summarizeMessage(msg),
          });
          continue;
        }

        const dedupeResult = this.#messageDedupe.check(msg, messageType);

        if (dedupeResult.duplicate) {
          this.emit("msg_duplicate", dedupeResult);
          continue;
        }

        if (dedupeResult.collision) {
          this.emit("msg_dedupe_collision", dedupeResult);
        }

        this.emit("msg", { type: messageType, ...msg });
      }
    });

    this.#conn.ev.on("presence.update", (presence) => {
      this.emit("presence_update", presence);
    });

    this.emit("ready");
  };

  #onDisconnected = ({ lastDisconnect }) => {
    this.#status.connected = false;

    clearInterval(this.#refreshInterval);
    this.setSendPresenceUpdateInterval();

    const statusCode = lastDisconnect?.error?.output?.statusCode;

    if (statusCode === DisconnectReason.loggedOut) {
      this.#status.reconnecting = false;
      this.#status.disconnected = true;

      this.emit("logout");
      return;
    }

    this.emit("disconnected", statusCode);
    this.#reconnect();
  };

  setSendPresenceUpdateInterval = (status, id) => {
    clearInterval(this.#sendPresenceUpdateInterval);

    if (status) {
      try {
        this.sendPresenceUpdate(status, id);
      } catch (err) {
        clearInterval(this.#sendPresenceUpdateInterval);
      }

      this.#sendPresenceUpdateInterval = setInterval(() => {
        try {
          this.sendPresenceUpdate(status, id);
        } catch (err) {
          clearInterval(this.#sendPresenceUpdateInterval);
        }
      }, 10000);
    }
  };

  sendMessage = async (phone, msg, options) => {
    phone = phone.toString().trim();

    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    const id = this.#toId(phone);

    if (this.#isDirectJid(phone)) {
      try {
        return await this.#conn.sendMessage(id, msg, options);
      } catch (err) {
        throw new WhatsappError(this.#getErrorCode(err));
      }
    }

    const [result] = await this.#conn.onWhatsApp(id);

    if (result) {
      try {
        return await this.#conn.sendMessage(id, msg, options);
      } catch (err) {
        throw new WhatsappError(this.#getErrorCode(err));
      }
    }

    throw new WhatsappNumberNotFoundError(phone);
  };

  waitForMessage(from, callback) {
    this.once("msg", (msg) => {
      if (msg.key.remoteJid === this.#toId(from)) callback(msg);
    });
  }

  sendPresenceUpdate = async (type, id) => {
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    try {
      await this.#conn.sendPresenceUpdate(type, id);
    } catch (err) {
      throw new WhatsappError(this.#getErrorCode(err));
    }
  };

  presenceSubscribe = async (phone) => {
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    phone = phone.toString().trim();
    const id = this.#toId(phone);

    if (this.#isDirectJid(phone)) {
      try {
        await this.#conn.presenceSubscribe(id);
      } catch (err) {
        throw new WhatsappError(this.#getErrorCode(err));
      }
      return;
    }

    const [result] = await this.#conn.onWhatsApp(id);

    if (result) {
      try {
        await this.#conn.presenceSubscribe(id);
      } catch (err) {
        throw new WhatsappError(this.#getErrorCode(err));
      }
    } else {
      throw new WhatsappNumberNotFoundError(phone);
    }
  };

  readMessages = async (keys) => {
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }
    try {
      await this.#conn.readMessages(keys);
    } catch (err) {
      throw new WhatsappError(this.#getErrorCode(err));
    }
  };

  updateProfileStatus = async (status) => {
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    try {
      await this.#conn.updateProfileStatus(status);
    } catch (err) {
      throw new WhatsappError(this.#getErrorCode(err));
    }
  };
}

class WhatsappNumberNotFoundError extends Error {
  constructor(phone = "", ...args) {
    super(phone, ...args);
    this.name = "WhatsappNumberNotFoundError";
    this.message = `Send message failed. Number ${phone} is not on Whatsapp.`;
    this.code = 404;
  }
}

class WhatsappDisconnectedError extends Error {
  constructor(message = "", ...args) {
    super(message, ...args);
    this.name = "WhatsappDisconnectedError";
    this.code = 401;
    this.message = `Send message failed. Whatsapp disconnected error.`;
  }
}

class WhatsappError extends Error {
  #errors = {
    428: "Connection Closed",
    408: "Timed Out",
    440: "Connection Replaced",
    401: "Logged Out",
    500: "Bad Session",
    515: "Restart Required",
    411: "Multidevice Mismatch",
  };

  constructor(message = "", ...args) {
    super(message, ...args);
    this.name = "WhatsappError";
    this.code = Number(this.message);
    this.message = `Send message failed. Whatsapp error ${this.message}: ${
      this.#errors[this.code] || "Unknown Error"
    }`;
  }
}

module.exports = { WhatsappClient, MessageType };
