const EventEmitter = require("eventemitter2");

const { MessageDedupe } = require("./message-dedupe");
const {
  RequestValidationError,
  normalizePhoneJid,
  requireString,
} = require("./validation");

const MessageType = {
  text: "conversation",
  location: "locationMessage",
  liveLocation: "liveLocationMessage",
  image: "imageMessage",
  video: "videoMessage",
  document: "documentMessage",
  contact: "contactMessage",
};

const DIRECT_JID_PATTERNS = [
  /^[1-9]\d{4,14}@s\.whatsapp\.net$/,
  /^\d[\d-]{3,62}\d@g\.us$/,
  /^(?:status|\d{5,30})@broadcast$/,
  /^[1-9]\d{4,30}@lid$/,
];

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeRecipientJid = (value) => {
  const recipient = requireString(value, "recipient", { maxLength: 128 });

  if (/^\+?[1-9]\d{4,14}$/.test(recipient)) {
    return normalizePhoneJid(recipient);
  }

  if (DIRECT_JID_PATTERNS.some((pattern) => pattern.test(recipient))) {
    return recipient;
  }

  throw new RequestValidationError("The WhatsApp recipient is invalid.");
};

const isDirectJid = (value) =>
  DIRECT_JID_PATTERNS.some((pattern) => pattern.test(value));

const safeUpstreamCode = (error) => {
  const code =
    error?.output?.payload?.statusCode ??
    error?.output?.statusCode ??
    error?.statusCode;

  return Number.isInteger(code) ? code : "unknown";
};

class WhatsappNumberNotFoundError extends Error {
  constructor() {
    super("The phone number is not registered on WhatsApp.");
    this.name = "WhatsappNumberNotFoundError";
    this.code = 404;
  }
}

class WhatsappDisconnectedError extends Error {
  constructor() {
    super("The WhatsApp client is not connected.");
    this.name = "WhatsappDisconnectedError";
    this.code = 503;
  }
}

class WhatsappUpstreamError extends Error {
  constructor(operation = "request", upstreamCode = "unknown") {
    super(`WhatsApp could not complete the ${operation}.`);
    this.name = "WhatsappUpstreamError";
    this.code = 502;
    this.upstreamCode = upstreamCode;
  }
}

class WhatsappProtocolError extends WhatsappUpstreamError {
  constructor() {
    super("request", "malformed_response");
    this.name = "WhatsappProtocolError";
  }
}

// Retain the old export name for consumers that imported it directly.
class WhatsappError extends WhatsappUpstreamError {
  constructor(upstreamCode = "unknown") {
    super("request", upstreamCode);
    this.name = "WhatsappError";
  }
}

class WhatsappClient extends EventEmitter {
  #conn;
  #path;
  #refreshInterval;
  #sendPresenceUpdateInterval;
  #reconnectTimer;
  #connectPromise;
  #timeout;
  #attempts;
  #messageDedupe;
  #offline;
  #refreshMs;
  #baileys;
  #socketLogger;

  #status = {
    attempt: 0,
    connected: false,
    disconnected: false,
    reconnecting: false,
  };

  #toMilliseconds = (hours, minutes, seconds) =>
    (hours * 60 * 60 + minutes * 60 + seconds) * 1000;

  constructor({
    path,
    timeout = 1_000,
    attempts = Infinity,
    offline = true,
    refreshMs,
    baileys,
    socketLogger,
    autoConnect = true,
  }) {
    super();

    if (typeof path !== "string" || !path) {
      throw new TypeError("A session path is required.");
    }

    this.#path = path;
    this.#timeout = timeout;
    this.#attempts = attempts;
    this.#offline = offline;
    this.#refreshMs = refreshMs || this.#toMilliseconds(6, 0, 0);
    this.#messageDedupe = new MessageDedupe();
    this.#baileys = baileys || import("@whiskeysockets/baileys");
    this.#socketLogger =
      socketLogger || require("pino")({ level: "silent" });

    if (autoConnect) {
      void this.connect().catch((error) => this.#handleConnectFailure(error));
    }
  }

  connect = async () => {
    if (this.#status.connected) return;
    if (this.#connectPromise) return this.#connectPromise;

    clearTimeout(this.#reconnectTimer);
    this.#connectPromise = this.#connect();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  };

  #connect = async () => {
    const baileys = await this.#baileys;
    this.#baileys = baileys;
    const {
      default: makeWASocket,
      fetchLatestBaileysVersion,
      useMultiFileAuthState,
    } = baileys;
    if (
      typeof makeWASocket !== "function" ||
      typeof fetchLatestBaileysVersion !== "function" ||
      typeof useMultiFileAuthState !== "function"
    ) {
      throw new WhatsappProtocolError();
    }

    const versionResult = await fetchLatestBaileysVersion();
    if (
      !versionResult ||
      !Array.isArray(versionResult.version) ||
      versionResult.version.length !== 3 ||
      !versionResult.version.every(Number.isInteger)
    ) {
      throw new WhatsappProtocolError();
    }

    const authResult = await useMultiFileAuthState(this.#path);
    if (
      !authResult ||
      !authResult.state ||
      typeof authResult.saveCreds !== "function"
    ) {
      throw new WhatsappProtocolError();
    }

    this.#conn = makeWASocket({
      version: versionResult.version,
      auth: authResult.state,
      syncFullHistory: false,
      markOnlineOnConnect: !this.#offline,
      logger: this.#socketLogger,
      generateHighQualityLinkPreview: true,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      defaultQueryTimeoutMs: undefined,
    });
    if (!this.#conn?.ev || typeof this.#conn.ev.on !== "function") {
      throw new WhatsappProtocolError();
    }

    this.#conn.ev.on("creds.update", (state) => {
      if (state?.me?.id) {
        this.emit("pair", {
          phone: state.me.id.split(":")[0],
          name: state.me.name,
        });
      }

      Promise.resolve()
        .then(() => authResult.saveCreds(state))
        .catch((error) => {
          this.emit(
            "client_error",
            new WhatsappUpstreamError(
              "credential update",
              safeUpstreamCode(error)
            )
          );
        });
    });

    this.#conn.ev.on("connection.update", this.#onConnectionUpdate);
  };

  #handleConnectFailure = (error) => {
    const safeError =
      error instanceof WhatsappUpstreamError
        ? error
        : new WhatsappUpstreamError("connection", safeUpstreamCode(error));
    this.emit("client_error", safeError);
    this.#status.connected = false;
    this.#status.reconnecting = true;
    this.#scheduleReconnect();
  };

  disconnect = async (reconnect = false) => {
    clearInterval(this.#refreshInterval);
    clearInterval(this.#sendPresenceUpdateInterval);
    clearTimeout(this.#reconnectTimer);

    this.#status.connected = false;
    this.#status.disconnected = !reconnect;
    this.#status.reconnecting = !!reconnect;

    if (this.#conn && typeof this.#conn.end === "function") {
      await this.#conn.end();
    }
  };

  restart = async () => {
    this.emit("restart");
    await this.disconnect(true);
  };

  #assertConnected = () => {
    if (
      this.#status.disconnected ||
      !this.#status.connected ||
      !this.#conn
    ) {
      throw new WhatsappDisconnectedError();
    }
  };

  #getMessageType = (message) => {
    if (!message?.message) return undefined;
    return Object.keys(message.message).find(
      (key) => key !== "messageContextInfo"
    );
  };

  #summarizeMessage = (message) => ({
    hasMessage: !!message?.message,
    fromMe: !!message?.key?.fromMe,
    messageId: message?.key?.id,
    remoteJid: message?.key?.remoteJid,
    participant: message?.key?.participant,
    type: this.#getMessageType(message),
    messageStubType: message?.messageStubType,
    messageTimestamp: message?.messageTimestamp,
  });

  #scheduleReconnect = () => {
    if (
      this.#status.attempt >= this.#attempts ||
      this.#status.disconnected
    ) {
      this.#status.reconnecting = false;
      this.#status.disconnected = true;
      return;
    }

    this.#status.attempt += 1;
    clearTimeout(this.#reconnectTimer);
    this.emit("reconnect_scheduled", {
      attempt: this.#status.attempt,
      delayMs: this.#timeout,
    });
    this.#reconnectTimer = setTimeout(() => {
      void this.connect().catch((error) => this.#handleConnectFailure(error));
    }, this.#timeout);
    this.#reconnectTimer.unref?.();
  };

  #onConnectionUpdate = (event) => {
    if (event?.qr) this.emit("qr", event.qr);
    if (event?.connection === "open") this.#onConnected();
    else if (event?.connection === "close") this.#onDisconnected(event);
  };

  #onConnected = () => {
    if (this.#status.connected) return;

    this.#status.attempt = 0;
    this.#status.connected = true;
    this.#status.disconnected = false;
    this.#status.reconnecting = false;

    clearInterval(this.#refreshInterval);
    this.#refreshInterval = setInterval(() => {
      void this.restart().catch((error) => this.#handleConnectFailure(error));
    }, this.#refreshMs);
    this.#refreshInterval.unref?.();

    if (this.#offline) {
      void this.setSendPresenceUpdateInterval("unavailable").catch((error) => {
        this.emit(
          "client_error",
          error instanceof WhatsappUpstreamError
            ? error
            : new WhatsappUpstreamError(
                "presence update",
                safeUpstreamCode(error)
              )
        );
      });
    }

    this.#conn.ev.on("messages.upsert", async ({ messages, type, requestId }) => {
      this.emit("msg_upsert", {
        count: messages?.length || 0,
        type,
        requestId,
        messages: (messages || []).map((message) =>
          this.#summarizeMessage(message)
        ),
      });

      for (const message of messages || []) {
        if (!message?.message) {
          this.emit("msg_ignored", {
            reason: "missing_message",
            message: this.#summarizeMessage(message),
          });
          continue;
        }

        if (message.key?.fromMe) {
          this.emit("msg_ignored", {
            reason: "from_me",
            message: this.#summarizeMessage(message),
          });
          continue;
        }

        delete message.message.messageContextInfo;
        const messageType = this.#getMessageType(message);
        if (!messageType) {
          this.emit("msg_ignored", {
            reason: "missing_message_type",
            message: this.#summarizeMessage(message),
          });
          continue;
        }

        const dedupeResult = this.#messageDedupe.check(message, messageType);
        if (dedupeResult.duplicate) {
          this.emit("msg_duplicate", dedupeResult);
          continue;
        }

        if (dedupeResult.collision) {
          this.emit("msg_dedupe_collision", dedupeResult);
        }

        this.emit("msg", { type: messageType, ...message });
      }
    });

    this.#conn.ev.on("presence.update", (presence) => {
      this.emit("presence_update", presence);
    });

    this.#conn.ev.on("call", (calls) => {
      if (!Array.isArray(calls)) return;
      for (const call of calls) this.emit("call_update", call);
    });

    this.emit("ready");
  };

  #onDisconnected = ({ lastDisconnect } = {}) => {
    this.#status.connected = false;
    clearInterval(this.#refreshInterval);
    clearInterval(this.#sendPresenceUpdateInterval);

    const upstreamCode = safeUpstreamCode(lastDisconnect?.error);
    const statusCode = Number.isInteger(upstreamCode) ? upstreamCode : null;
    if (statusCode === this.#baileys.DisconnectReason?.loggedOut) {
      this.#status.reconnecting = false;
      this.#status.disconnected = true;
      this.emit("logout");
      return;
    }

    this.#status.reconnecting = true;
    this.emit("disconnected", Number.isInteger(statusCode) ? statusCode : null);
    this.#scheduleReconnect();
  };

  #runUpstream = async (operation, callback) => {
    try {
      return await callback();
    } catch (error) {
      if (
        error instanceof WhatsappDisconnectedError ||
        error instanceof WhatsappProtocolError ||
        error instanceof RequestValidationError
      ) {
        throw error;
      }

      throw new WhatsappUpstreamError(operation, safeUpstreamCode(error));
    }
  };

  #lookupNumber = async (jid) => {
    const results = await this.#runUpstream("number check", () =>
      this.#conn.onWhatsApp(jid)
    );
    if (!Array.isArray(results)) {
      throw new WhatsappProtocolError();
    }
    if (results.length === 0) {
      return { jid, exists: false, lid: null };
    }
    if (results.length !== 1 || !isPlainObject(results[0])) {
      throw new WhatsappProtocolError();
    }

    const result = results[0];
    if (result.jid !== jid || typeof result.exists !== "boolean") {
      throw new WhatsappProtocolError();
    }
    if (
      result.lid !== undefined &&
      result.lid !== null &&
      (typeof result.lid !== "string" ||
        !/^[1-9]\d{4,30}@lid$/.test(result.lid))
    ) {
      throw new WhatsappProtocolError();
    }

    return {
      jid,
      exists: result.exists,
      lid: result.exists ? result.lid || null : null,
    };
  };

  checkNumber = async (to) => {
    this.#assertConnected();
    const jid = normalizePhoneJid(to);
    return this.#lookupNumber(jid);
  };

  setSendPresenceUpdateInterval = async (status, recipient) => {
    clearInterval(this.#sendPresenceUpdateInterval);
    this.#sendPresenceUpdateInterval = undefined;
    if (!status) return;

    await this.sendPresenceUpdate(status, recipient);
    this.#sendPresenceUpdateInterval = setInterval(() => {
      void this.sendPresenceUpdate(status, recipient).catch((error) => {
        clearInterval(this.#sendPresenceUpdateInterval);
        this.#sendPresenceUpdateInterval = undefined;
        this.emit(
          "client_error",
          error instanceof WhatsappUpstreamError
            ? error
            : new WhatsappUpstreamError(
                "presence update",
                safeUpstreamCode(error)
              )
        );
      });
    }, 10_000);
    this.#sendPresenceUpdateInterval.unref?.();
  };

  sendMessage = async (recipient, message, options) => {
    this.#assertConnected();
    const jid = normalizeRecipientJid(recipient);

    if (!isDirectJid(requireString(recipient, "recipient", { maxLength: 128 }))) {
      const result = await this.#lookupNumber(jid);
      if (!result.exists) throw new WhatsappNumberNotFoundError();
    }

    return this.#runUpstream("message send", () =>
      this.#conn.sendMessage(jid, message, options)
    );
  };

  waitForMessage(from, callback) {
    const jid = normalizeRecipientJid(from);
    this.once("msg", (message) => {
      if (message.key.remoteJid === jid) callback(message);
    });
  }

  sendPresenceUpdate = async (type, recipient) => {
    this.#assertConnected();
    const jid =
      recipient === undefined || recipient === null
        ? undefined
        : normalizeRecipientJid(recipient);

    await this.#runUpstream("presence update", () =>
      this.#conn.sendPresenceUpdate(type, jid)
    );
  };

  presenceSubscribe = async (recipient) => {
    this.#assertConnected();
    const jid = normalizeRecipientJid(recipient);

    if (!isDirectJid(requireString(recipient, "recipient", { maxLength: 128 }))) {
      const result = await this.#lookupNumber(jid);
      if (!result.exists) throw new WhatsappNumberNotFoundError();
    }

    await this.#runUpstream("presence subscription", () =>
      this.#conn.presenceSubscribe(jid)
    );
  };

  readMessages = async (keys) => {
    this.#assertConnected();
    await this.#runUpstream("read receipt", () =>
      this.#conn.readMessages(keys)
    );
  };

  updateProfileStatus = async (status) => {
    this.#assertConnected();
    await this.#runUpstream("profile status update", () =>
      this.#conn.updateProfileStatus(status)
    );
  };
}

module.exports = {
  MessageType,
  WhatsappClient,
  WhatsappDisconnectedError,
  WhatsappError,
  WhatsappNumberNotFoundError,
  WhatsappProtocolError,
  WhatsappUpstreamError,
  isDirectJid,
  normalizeRecipientJid,
  safeUpstreamCode,
};
