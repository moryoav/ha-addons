const crypto = require("crypto");
const fs = require("fs");

const axios = require("axios");
const qrimage = require("qr-image");

const { createApiApp } = require("./api");
const {
  DEFAULT_HEALTH_FAILURE_PATH,
  DEFAULT_HEARTBEAT_PATH,
  createHealthFailureReport,
  createRunId,
  createRuntimeDiagnostics,
  formatHealthFailureNotification,
  replayHealthcheckDiagnostics,
} = require("./diagnostics");
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
const DEBUG_MESSAGE_LIMIT = 10;
const CALL_UPDATE_EVENT = "whatsapp_call_update";
const CALL_EVENT_RETRY_DELAYS_MS = Object.freeze([
  1_000,
  2_000,
  5_000,
  10_000,
  15_000,
]);
const CALL_EVENT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PENDING_CALL_UPDATES = 100;
const HEALTH_FAILURE_EVENT = "whatsapp_addon_health_failure";
const HEALTH_FAILURE_NOTIFICATION_ID = "whatsapp_addon_health_failure";

const CALL_STATUSES = new Set([
  "offer",
  "ringing",
  "accept",
  "reject",
  "timeout",
  "terminate",
]);

const SAFE_MESSAGE_TYPES = new Set([
  "audioMessage",
  "buttonsMessage",
  "contactMessage",
  "contactsArrayMessage",
  "conversation",
  "documentMessage",
  "extendedTextMessage",
  "imageMessage",
  "interactiveMessage",
  "listMessage",
  "listResponseMessage",
  "liveLocationMessage",
  "locationMessage",
  "pollCreationMessage",
  "pollUpdateMessage",
  "protocolMessage",
  "reactionMessage",
  "stickerMessage",
  "templateButtonReplyMessage",
  "videoMessage",
]);

const SAFE_UPSERT_TYPES = new Set(["append", "notify"]);
const SAFE_IGNORED_REASONS = new Set([
  "from_me",
  "missing_message",
  "missing_message_type",
]);

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

const isTransientSupervisorStatus = (status) =>
  status === undefined ||
  status === 408 ||
  status === 429 ||
  (status >= 500 && status <= 599);

const safeUpstreamCode = (error) => {
  const code = error?.upstreamCode;
  return (Number.isInteger(code) && code >= 0 && code <= 9_999) ||
    code === "malformed_response"
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

const normalizeLogLevel = (value) => {
  if (value === undefined) return "info";
  if (value !== "info" && value !== "debug") {
    throw new RequestValidationError("log_level must be info or debug.");
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
    logLevel: normalizeLogLevel(options.log_level),
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

const safeMessageType = (value) =>
  SAFE_MESSAGE_TYPES.has(value) ? value : value ? "other" : undefined;

const safeUpsertType = (value) =>
  SAFE_UPSERT_TYPES.has(value) ? value : value ? "other" : undefined;

const safeIgnoredReason = (value) =>
  SAFE_IGNORED_REASONS.has(value) ? value : "other";

const safeDiagnosticTimestamp = (value) => {
  if (
    Number.isSafeInteger(value) &&
    ((value >= 946_684_800 && value <= 4_102_444_800) ||
      (value >= 946_684_800_000 && value <= 4_102_444_800_000))
  ) {
    return value;
  }
  if (
    typeof value === "string" &&
    value.length <= 32 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return value;
  }
  return undefined;
};

const normalizeCallString = (value, maxLength) =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;

const normalizeCallDate = (value) => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return typeof value === "string" && safeDiagnosticTimestamp(value)
    ? value
    : null;
};

const normalizeCallUpdate = (call) => {
  if (
    !call ||
    typeof call !== "object" ||
    Array.isArray(call) ||
    !CALL_STATUSES.has(call.status)
  ) {
    return undefined;
  }

  return {
    callId: normalizeCallString(call.id, 256),
    status: call.status,
    from: normalizeCallString(call.from, 128),
    chatId: normalizeCallString(call.chatId, 128),
    isVideo: typeof call.isVideo === "boolean" ? call.isVideo : null,
    isGroup: typeof call.isGroup === "boolean" ? call.isGroup : null,
    groupJid: normalizeCallString(call.groupJid, 128),
    date: normalizeCallDate(call.date),
    offline: typeof call.offline === "boolean" ? call.offline : null,
  };
};

const summarizeMessageDebug = (message, fingerprintValue = fingerprint) => ({
  hasMessage: !!message?.hasMessage,
  fromMe: !!message?.fromMe,
  type: safeMessageType(message?.type),
  messageRef: fingerprintValue(message?.messageId),
  chatRef: fingerprintValue(message?.remoteJid),
  participantRef: fingerprintValue(message?.participant),
  messageStubType:
    Number.isInteger(message?.messageStubType) &&
    message.messageStubType >= 0 &&
    message.messageStubType <= 10_000
    ? message.messageStubType
    : undefined,
  messageTimestamp: safeDiagnosticTimestamp(message?.messageTimestamp),
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
  logLevel = "info",
  runId = createRunId(),
  diagnostics,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) => {
  const validatedClientIds = normalizeConfiguredClientIds(clientIds);
  const clients = Object.create(null);
  const clientStates = Object.create(null);
  const logoutTasks = new Map();
  const logRef = (value) => fingerprint(value, fingerprintKey);
  const debugEnabled = normalizeLogLevel(logLevel) === "debug";
  const callRetryWaiters = new Map();
  let callDeliveryStopped = false;
  let callDeliveryTail = Promise.resolve();
  let pendingCallUpdates = 0;

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

  const requestSupervisor = async (path, payload, timeout) => {
    try {
      await httpClient.post(`http://supervisor${path}`, payload, {
        headers: supervisorHeaders,
        ...(Number.isInteger(timeout) ? { timeout } : {}),
      });
      return { delivered: true, status: undefined };
    } catch (error) {
      return { delivered: false, status: safeHttpStatus(error) };
    }
  };

  const postSupervisor = async (path, payload, operation) => {
    const result = await requestSupervisor(path, payload);
    if (!result.delivered) {
      logger.warn?.(`Supervisor ${operation} failed.`, {
        runId,
        status: result.status,
      });
    }
    return result.delivered;
  };

  const waitForCallRetry = (delayMs) => {
    if (callDeliveryStopped) return Promise.resolve(false);

    return new Promise((resolve) => {
      const timer = setTimeoutFn(() => {
        callRetryWaiters.delete(timer);
        resolve(!callDeliveryStopped);
      }, delayMs);
      callRetryWaiters.set(timer, resolve);
    });
  };

  const deliverCallUpdate = async (clientId, update) => {
    for (let attempt = 1; ; attempt += 1) {
      if (callDeliveryStopped) return { delivered: false, attempt: 0 };

      const result = await requestSupervisor(
        `/core/api/events/${CALL_UPDATE_EVENT}`,
        { clientId, ...update },
        CALL_EVENT_REQUEST_TIMEOUT_MS
      );
      if (result.delivered) {
        return { delivered: true, attempt };
      }

      const retryInMs = CALL_EVENT_RETRY_DELAYS_MS[attempt - 1];
      if (
        retryInMs !== undefined &&
        !callDeliveryStopped &&
        isTransientSupervisorStatus(result.status)
      ) {
        logger.warn?.(
          "Home Assistant call event delivery temporarily failed; retry scheduled.",
          {
            runId,
            clientRef: logRef(clientId),
            callStatus: update.status,
            httpStatus: result.status,
            attempt,
            retryInMs,
          }
        );
        if (await waitForCallRetry(retryInMs)) continue;
        return { delivered: false, attempt };
      }

      logger.warn?.("Home Assistant call event delivery failed.", {
        runId,
        clientRef: logRef(clientId),
        callStatus: update.status,
        httpStatus: result.status,
        attempt,
      });
      return { delivered: false, attempt };
    }
  };

  const stopCallDelivery = () => {
    callDeliveryStopped = true;
    for (const [timer, resolve] of callRetryWaiters) {
      clearTimeoutFn(timer);
      resolve(false);
    }
    callRetryWaiters.clear();
    return callDeliveryTail;
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
      runId,
      clientRef: logRef(clientId),
    });
    diagnostics?.recordConnection?.("connected");
    void postSupervisor(
      "/core/api/services/persistent_notification/dismiss",
      { notification_id: `whatsapp_addon_qrcode_${clientId}` },
      "notification dismissal"
    );
  };

  const onQr = (qr, clientId) => {
    logger.info?.("WhatsApp client requires QR pairing.", {
      runId,
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
        runId,
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
    diagnostics?.recordConnection?.("disconnected");
    logger.warn?.("WhatsApp client disconnected; reconnect scheduled.", {
      runId,
      clientRef: logRef(clientId),
      upstreamCode:
        Number.isInteger(statusCode) && statusCode >= 0 && statusCode <= 9_999
          ? statusCode
          : undefined,
    });
  };

  const onClientError = (error, clientId) => {
    diagnostics?.recordConnection?.("error");
    logger.warn?.("WhatsApp client operation failed.", {
      runId,
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
      diagnostics?.recordMessageDelivered?.(delivered);
      if (!delivered || !debugEnabled) return;
      logger.debug?.("WhatsApp message event delivered.", {
        runId,
        clientRef: logRef(clientId),
        type: safeMessageType(message.type),
        messageRef: logRef(message?.key?.id),
        chatRef: logRef(message?.key?.remoteJid),
      });
    });
  };

  const onMsgUpsert = (upsert, clientId) => {
    diagnostics?.recordMessageBatch?.(upsert.count);
    if (!debugEnabled) return;
    const messages = Array.isArray(upsert.messages) ? upsert.messages : [];
    logger.debug?.("WhatsApp messages received.", {
      runId,
      clientRef: logRef(clientId),
      count:
        Number.isInteger(upsert.count) &&
        upsert.count >= 0 &&
        upsert.count <= 100_000
          ? upsert.count
          : messages.length,
      type: safeUpsertType(upsert.type),
      requestRef: logRef(upsert.requestId),
      messages: messages.slice(0, DEBUG_MESSAGE_LIMIT).map((message) =>
        summarizeMessageDebug(message, logRef)
      ),
      omitted: Math.max(0, messages.length - DEBUG_MESSAGE_LIMIT),
    });
  };

  const onIgnoredMsg = (ignored, clientId) => {
    diagnostics?.recordMessageIgnored?.(ignored.reason);
    if (!debugEnabled) return;
    logger.debug?.("WhatsApp message ignored before event delivery.", {
      runId,
      clientRef: logRef(clientId),
      reason: safeIgnoredReason(ignored.reason),
      message: summarizeMessageDebug(ignored.message, logRef),
    });
  };

  const onDuplicateMsg = (duplicate, clientId) => {
    diagnostics?.recordMessageDuplicate?.();
    if (!debugEnabled) return;
    logger.debug?.("Duplicate WhatsApp message dropped.", {
      runId,
      clientRef: logRef(clientId),
      messageRef: logRef(duplicate.keyId),
      type: safeMessageType(duplicate.type),
      firstChatRef: logRef(duplicate.firstRemoteJid),
      duplicateChatRef: logRef(duplicate.duplicateRemoteJid),
      firstSeenAt: safeDiagnosticTimestamp(duplicate.firstSeenAt),
      duplicateSeenAt: safeDiagnosticTimestamp(duplicate.duplicateSeenAt),
      ageMs:
        Number.isSafeInteger(duplicate.ageMs) &&
        duplicate.ageMs >= 0 &&
        duplicate.ageMs <= 86_400_000
          ? duplicate.ageMs
          : undefined,
    });
  };

  const onDedupeCollision = (collision, clientId) => {
    diagnostics?.recordMessageCollision?.();
    logger.warn?.("WhatsApp message dedupe collision; message allowed.", {
      runId,
      clientRef: logRef(clientId),
      messageRef: logRef(collision.keyId),
      type: safeMessageType(collision.type),
      firstChatRef: logRef(collision.firstRemoteJid),
      chatRef: logRef(collision.remoteJid),
      firstSeenAt: safeDiagnosticTimestamp(collision.firstSeenAt),
      collisionAt: safeDiagnosticTimestamp(collision.collisionAt),
      ageMs:
        Number.isSafeInteger(collision.ageMs) &&
        collision.ageMs >= 0 &&
        collision.ageMs <= 86_400_000
          ? collision.ageMs
          : undefined,
    });
  };

  const onCallUpdate = (call, clientId) => {
    const update = normalizeCallUpdate(call);
    if (!update) {
      diagnostics?.recordCallIgnored?.();
      if (debugEnabled) {
        logger.debug?.("Malformed WhatsApp call update ignored.", {
          runId,
          clientRef: logRef(clientId),
        });
      }
      return;
    }

    diagnostics?.recordCallUpdate?.(update.status);
    if (pendingCallUpdates >= MAX_PENDING_CALL_UPDATES) {
      diagnostics?.recordCallDelivered?.(false);
      logger.warn?.(
        "WhatsApp call update dropped because the delivery queue is full.",
        {
          runId,
          clientRef: logRef(clientId),
          callStatus: update.status,
          queueLimit: MAX_PENDING_CALL_UPDATES,
        }
      );
      return;
    }

    pendingCallUpdates += 1;
    const deliveryTask = callDeliveryTail.then(async () => {
      try {
        return await deliverCallUpdate(clientId, update);
      } catch {
        logger.warn?.(
          "Home Assistant call event delivery failed unexpectedly.",
          {
            runId,
            clientRef: logRef(clientId),
            callStatus: update.status,
          }
        );
        return { delivered: false, attempt: 0 };
      }
    });
    callDeliveryTail = deliveryTask.then(() => undefined);

    void deliveryTask.then((result) => {
      pendingCallUpdates -= 1;
      diagnostics?.recordCallDelivered?.(result.delivered);
      if (!result.delivered) return;
      logger.info?.("WhatsApp call update event delivered.", {
        runId,
        clientRef: logRef(clientId),
        callStatus: update.status,
        attempt: result.attempt,
      });
      if (!debugEnabled) return;
      logger.debug?.("WhatsApp call update event delivered.", {
        runId,
        clientRef: logRef(clientId),
        callRef: logRef(update.callId),
        callerRef: logRef(update.from),
        status: update.status,
        isVideo: update.isVideo,
        isGroup: update.isGroup,
        offline: update.offline,
      });
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
      diagnostics?.recordConnection?.("restarted");
      logger.info?.("WhatsApp client restarting.", {
        runId,
        clientRef: logRef(clientId),
      });
    });
    client.on("reconnect_scheduled", (details = {}) => {
      diagnostics?.recordConnection?.("reconnect_scheduled");
      if (!debugEnabled) return;
      logger.debug?.("WhatsApp client reconnect scheduled.", {
        runId,
        clientRef: logRef(clientId),
        attempt:
          Number.isInteger(details.attempt) &&
          details.attempt >= 1 &&
          details.attempt <= 1_000_000
            ? details.attempt
            : undefined,
        delayMs:
          Number.isInteger(details.delayMs) &&
          details.delayMs >= 0 &&
          details.delayMs <= 86_400_000
            ? details.delayMs
            : undefined,
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
    client.on("call_update", (call) => onCallUpdate(call, clientId));
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
          runId,
          clientRef: logRef(clientId),
        });
        diagnostics?.recordConnection?.("logged_out");

        const oldClient = clients[clientId];
        oldClient?.removeAllListeners?.();
        delete clients[clientId];
        await removeSessionDirectory({ dataRoot, clientId, fsPromises });
        initClient(clientId);
      })()
        .catch(() => {
          setClientState(clientId, { state: "disconnected" });
          logger.error?.("WhatsApp session reset failed.", {
            runId,
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
    if (registered) {
      logger.info?.("WhatsApp add-on discovery registered.", { runId });
    }
  };

  const reportHealthFailure = async (report) => {
    const eventDelivered = await postSupervisor(
      `/core/api/events/${HEALTH_FAILURE_EVENT}`,
      report,
      "health failure event delivery"
    );
    let notificationDelivered = false;

    if (debugEnabled) {
      notificationDelivered = await postSupervisor(
        "/core/api/services/persistent_notification/create",
        {
          title: "WhatsApp add-on health failure",
          message: formatHealthFailureNotification(report),
          notification_id: HEALTH_FAILURE_NOTIFICATION_ID,
        },
        "health failure notification"
      );
    }

    if (eventDelivered || notificationDelivered) {
      logger.info?.("Previous health failure reported to Home Assistant.", {
        runId,
        eventDelivered,
        notificationDelivered,
      });
    }

    return { eventDelivered, notificationDelivered };
  };

  return {
    apiToken,
    clientStates,
    clients,
    initClient,
    logoutTasks,
    registerDiscovery,
    reportHealthFailure,
    runId,
    stopCallDelivery,
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
  diagnosticsFactory = createRuntimeDiagnostics,
  replayHealthDiagnosticsFn = replayHealthcheckDiagnostics,
  healthFailurePath =
    process.env.HA_HEALTH_FAILURE_PATH || DEFAULT_HEALTH_FAILURE_PATH,
  heartbeatPath =
    process.env.HA_RUNTIME_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH,
  runId = createRunId(),
  ...runtimeOptions
} = {}) => {
  const options = await optionsLoader(optionsPath);
  const { clientIds, apiToken } = options;
  const logLevel = normalizeLogLevel(options.logLevel);
  if (logger && typeof logger === "object") logger.level = logLevel;

  const diagnostics = diagnosticsFactory({
    logger,
    logLevel,
    runId,
    heartbeatPath,
  });
  const safeRunId = diagnostics.runId || runId;
  const healthReplay = await replayHealthDiagnosticsFn({
    logger,
    runId: safeRunId,
    failurePath: healthFailurePath,
  });
  const healthFailureReport = createHealthFailureReport(
    healthReplay?.records,
    { runId: safeRunId }
  );
  logger.info?.("WhatsApp add-on runtime starting.", {
    runId: safeRunId,
    logLevel,
    clientCount: Array.isArray(clientIds) ? clientIds.length : 0,
  });
  await diagnostics.start?.();

  let runtime;
  let apiApp;
  let webUiApp;
  let apiServer;
  let webUiServer;
  try {
    runtime = createAddonRuntime({
      clientIds,
      apiToken,
      dataRoot,
      apiPort,
      logger,
      logLevel,
      runId: safeRunId,
      diagnostics,
      ...runtimeOptions,
    });
    diagnostics.setClientStateProvider?.(() => runtime.clientStates);

    apiApp = createApiApp({
      clients: runtime.clients,
      logger,
      sharedSecret: apiToken,
      diagnostics,
    });
    webUiApp = createWebUiApp({
      clients: runtime.clients,
      clientStates: runtime.clientStates,
    });

    apiServer = await listenFn(apiApp, apiPort);
    webUiServer = await listenFn(webUiApp, ingressPort);
    diagnostics.markApiReady?.();
  } catch (error) {
    if (runtime) {
      await Promise.allSettled(
        Object.values(runtime.clients).map((client) => client.disconnect?.())
      );
    }
    if (apiServer) await closeServerFn(apiServer);
    await diagnostics.stop?.();
    throw error;
  }
  logger.info?.("WhatsApp add-on API started.", { runId: safeRunId });
  logger.info?.("WhatsApp add-on ingress UI started.", { runId: safeRunId });
  await runtime.registerDiscovery();
  if (healthFailureReport) {
    await runtime.reportHealthFailure(healthFailureReport);
  }

  let closeTask;
  const close = () => {
    if (closeTask) return closeTask;
    closeTask = (async () => {
      logger.info?.("WhatsApp add-on runtime shutting down.", {
        runId: safeRunId,
      });
      const callDeliveryTask = runtime.stopCallDelivery?.();
      await Promise.allSettled([
        ...Object.values(runtime.clients).map((client) =>
          client.disconnect?.()
        ),
        callDeliveryTask,
      ]);
      await Promise.all([
        closeServerFn(apiServer),
        closeServerFn(webUiServer),
      ]);
      await diagnostics.stop?.();
      logger.info?.("WhatsApp add-on runtime stopped.", { runId: safeRunId });
    })();
    return closeTask;
  };

  return {
    ...runtime,
    apiApp,
    apiServer,
    webUiApp,
    webUiServer,
    diagnostics,
    healthFailureReport,
    close,
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
  normalizeLogLevel,
  normalizeCallUpdate,
  parseOptions,
  removeSessionDirectory,
  startAddon,
  summarizeMessageDebug,
};
