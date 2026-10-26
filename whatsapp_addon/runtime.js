const crypto = require("crypto");
const fs = require("fs");

const axios = require("axios");
const { PairingActionError, REQUEST_COOLDOWN_MS, normalizePairingPhone, pairingWebUiPath } = require("./pairing");
const qrimage = require("qr-image");

const { loadOrCreateApiToken, normalizeApiToken } = require("./api-token");
const { createApiApp } = require("./api");
const { summarizeSyncAction } = require("./app-state-sync");
const { CALL_LOG_EVENT, createCallLogTracker } = require("./call-log");
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
const { MediaStore, parseMediaOptions } = require("./media-store");
const { MessageInbox } = require("./message-inbox");
const {
  DEFAULT_RECOVERY_PATH,
  RECOVERY_REASON,
  RecoveryActionError,
  clearRecoveryRecord,
  createRecoveryRecord,
  persistRecoveryRecordSync,
  readRecoveryRecord,
} = require("./recovery");
const {
  RequestValidationError,
  normalizeClientId,
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
const RECOVERY_NOTIFICATION_ID = "whatsapp_addon_recovery_required";
// Retry a failed Web UI link lookup only after this pause, not on every pairing update.
const WEB_UI_LOOKUP_RETRY_MS = 5 * 60_000;

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

const normalizeLogLevel = (value) => {
  if (value === undefined) return "info";
  if (value !== "info" && value !== "debug") {
    throw new RequestValidationError("log_level must be info or debug.");
  }
  return value;
};

// Detailed decryption tracing is disabled. Keep these hooks for debugging.
// const normalizeDecryptionDiagnostics = (value) => {
//   if (value === undefined) return false;
//   if (typeof value !== "boolean") {
//     throw new RequestValidationError("decryption_diagnostics must be a boolean.");
//   }
//   return value;
// };

/** Validate configured accounts, media options and optional persistent delivery. */
const parseOptions = (content) => {
  let options;
  try {
    options = JSON.parse(content);
  } catch {
    throw new RequestValidationError("options.json must contain valid JSON.");
  }

  requirePlainObject(options, "options");
  const inboxClients = options.inbox_clients ?? [];
  if (!Array.isArray(inboxClients) || new Set(inboxClients).size !== inboxClients.length ||
      inboxClients.some((id) => !normalizeConfiguredClientIds(options.clients).includes(id))) {
    throw new RequestValidationError("inbox_clients must contain configured accounts without duplicates.");
  }
  return {
    clientIds: normalizeConfiguredClientIds(options.clients),
    apiToken: normalizeApiToken(options.api_token),
    logLevel: normalizeLogLevel(options.log_level),
    // decryptionDiagnostics: normalizeDecryptionDiagnostics(options.decryption_diagnostics),
    mediaOptions: parseMediaOptions(options),
    ...(inboxClients.length ? { inboxClients } : {}),
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

const MAX_LOGGED_COUNT = 1_000_000_000;

const safeCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_LOGGED_COUNT
    ? value
    : undefined;

// Offline sync counts are logged only as small named numbers.
const safeCounts = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result = {};
  for (const [key, count] of Object.entries(value).slice(0, 16)) {
    if (/^[a-z_]{1,32}$/.test(key) && safeCount(count) !== undefined) {
      result[key] = count;
    }
  }
  return result;
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

/** Connect configured accounts to Home Assistant events and the local app API. */
const createAddonRuntime = ({
  clientIds,
  apiToken,
  dataRoot = DATA_ROOT,
  logger = console,
  clientFactory = (options) => new WhatsappClient(options),
  fsModule = fs,
  fsPromises = fs.promises,
  httpClient = axios,
  supervisorToken = process.env.SUPERVISOR_TOKEN,
  hostname = process.env.HOSTNAME,
  apiPort = API_PORT,
  fingerprintKey = PROCESS_LOG_KEY,
  logLevel = "info",
  // decryptionDiagnostics = false,
  runId = createRunId(),
  diagnostics,
  mediaStore,
  messageInbox,
  inboxClients = [],
  initialRecoveryRecord,
  recoveryPath = DEFAULT_RECOVERY_PATH,
  persistRecoveryRecordSyncFn = persistRecoveryRecordSync,
  clearRecoveryRecordFn = clearRecoveryRecord,
  onRecoveryCleared,
  nowDate = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) => {
  const validatedClientIds = normalizeConfiguredClientIds(clientIds);
  const clients = Object.create(null);
  const clientStates = Object.create(null);
  const logoutTasks = new Map();
  const pairingTasks = new Map();
  const lastPairingRequests = new Map();
  const pairingNotifications = new Map();
  const pairingNotificationVersions = new Map();
  // Unlisted accounts may still show a notification from an earlier run, so they get one dismissal.
  const pairingNotificationsDismissed = new Set();
  let webUiPath;
  let webUiLookupFailedAt;
  let addonInfoTask;
  const logRef = (value) => fingerprint(value, fingerprintKey);
  const debugEnabled = normalizeLogLevel(logLevel) === "debug";
  // const decryptionDiagnosticsEnabled = normalizeDecryptionDiagnostics(decryptionDiagnostics);
  const callRetryWaiters = new Map();
  const recovery = {
    active: !!initialRecoveryRecord,
    reason: initialRecoveryRecord?.reason || null,
    detectedAt: initialRecoveryRecord?.detected_at || null,
    failedDecryptMessages:
      initialRecoveryRecord?.failed_decrypt_messages || 0,
    badMacSessionErrors: initialRecoveryRecord?.bad_mac_session_errors || 0,
    messageCounterSessionErrors:
      initialRecoveryRecord?.message_counter_session_errors || 0,
    operationPending: false,
  };
  let callDeliveryStopped = false;
  let callDeliveryTail = Promise.resolve();
  let pendingCallUpdates = 0;
  let recoveryNotificationSent = false;
  let recoveryTask;

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

  /** Post an event or service request with an optional HTTP timeout and private failure logs. */
  const postSupervisor = async (path, payload, operation, timeout) => {
    const result = await requestSupervisor(path, payload, timeout);
    if (!result.delivered) {
      logger.warn?.(`Supervisor ${operation} failed.`, {
        runId,
        status: result.status,
      });
    }
    return result.delivered;
  };

  /** Discover the installed repository-prefixed slug without a configured HA URL. */
  const resolveWebUiPath = async () => {
    if (webUiPath) return webUiPath;
    if (webUiLookupFailedAt !== undefined && nowDate().getTime() - webUiLookupFailedAt < WEB_UI_LOOKUP_RETRY_MS) return null;
    if (!addonInfoTask) {
      addonInfoTask = Promise.resolve().then(async () => {
        const options = { headers: supervisorHeaders, timeout: 5_000 };
        const [addon, core] = await Promise.allSettled([
          httpClient.get("http://supervisor/addons/self/info", options),
          httpClient.get("http://supervisor/core/info", options),
        ]);
        const coreVersion = core.value?.data?.data?.version;
        if (typeof coreVersion !== "string") return null;
        webUiPath = pairingWebUiPath(addon.value?.data?.data?.slug, coreVersion);
        return webUiPath;
      }).catch(() => null).then((path) => {
        // Use the plain-text fallback until the retry pause ends, without waiting on Supervisor.
        webUiLookupFailedAt = path ? undefined : nowDate().getTime();
        return path;
      }).finally(() => { addonInfoTask = undefined; });
    }
    return addonInfoTask;
  };

  /** Publish the latest pairing state after discovering its authenticated entry link. */
  const publishPairingNotification = async (clientId) => {
    const path = clientStates[clientId]?.state === "pairing" ? await resolveWebUiPath() : webUiPath;
    const state = clientStates[clientId];
    if (state?.state !== "pairing" || (!state.qrDataUrl && state.pairingMethod !== "phone")) {
      // Paired accounts reconnect often; dismiss only a notification that may still be shown.
      if (pairingNotificationsDismissed.has(clientId)) return;
      if (await postSupervisor("/core/api/services/persistent_notification/dismiss",
        { notification_id: `whatsapp_addon_qrcode_${clientId}` }, "notification dismissal", 5_000)) {
        pairingNotificationsDismissed.add(clientId);
      }
      return;
    }
    pairingNotificationsDismissed.delete(clientId);
    // Without a discovered path, name the Web UI in a phrase that also works mid-sentence.
    const page = path
      ? `[Open pairing page](${path})`
      : "Open the WhatsApp app's Web UI from its Home Assistant page";
    const link = path ? page : `${page}.`;
    const message = state.pairingMethod === "phone"
      ? state.pairingCode
        ? `Enter **${state.pairingCode}** in WhatsApp under **Linked devices > Link a device > Link with phone number instead**.\n\n${page} to request a new code or return to QR pairing.`
        : `Generating a phone-number pairing code for **${clientId}**.\n\n${link}`
      : `Scan this QR code using WhatsApp > Linked devices for **${clientId}**.\n\n![QR code](${state.qrDataUrl})\n\n**Prefer to link with your phone number?**\n\n${link}`;
    await postSupervisor("/core/api/services/persistent_notification/create", {
      title: `WhatsApp pairing (${clientId})`, message,
      notification_id: `whatsapp_addon_qrcode_${clientId}`,
    }, "pairing notification", 5_000);
  };

  /** Coalesce updates into one worker per account and serialize creates with dismissals. */
  const syncPairingNotification = (clientId) => {
    pairingNotificationVersions.set(clientId, (pairingNotificationVersions.get(clientId) || 0) + 1);
    if (pairingNotifications.has(clientId)) return pairingNotifications.get(clientId);
    const task = Promise.resolve().then(async () => {
      try {
        let revision;
        do {
          revision = pairingNotificationVersions.get(clientId);
          await publishPairingNotification(clientId);
        } while (revision !== pairingNotificationVersions.get(clientId));
      } finally {
        pairingNotifications.delete(clientId);
        pairingNotificationVersions.delete(clientId);
      }
    });
    pairingNotifications.set(clientId, task);
    return task;
  };

  /** Validate and serialize an explicit pairing choice for one configured account. */
  const runPairingAction = async (clientId, method, phoneNumber) => {
    let id;
    try { id = normalizeClientId(clientId); }
    catch { throw new PairingActionError(400, "invalid_request", "A valid account ID is required."); }
    if (!validatedClientIds.includes(id)) throw new PairingActionError(404, "client_not_found", "The account was not found.");
    const client = clients[id];
    if (callDeliveryStopped || recovery.active || recovery.operationPending || logoutTasks.has(id) || clientStates[id]?.state !== "pairing" || typeof client?.[method] !== "function") {
      throw new PairingActionError(409, "pairing_unavailable", "Wait for the account to be ready for pairing, then try again.");
    }
    if (pairingTasks.has(id)) throw new PairingActionError(409, "pairing_busy", "A pairing request is already in progress.");
    if (method === "requestPairingCode") {
      phoneNumber = normalizePairingPhone(phoneNumber);
      const now = nowDate().getTime();
      if (now - (lastPairingRequests.get(id) ?? -Infinity) < REQUEST_COOLDOWN_MS) {
        throw new PairingActionError(429, "pairing_rate_limited", "Wait 30 seconds before requesting another pairing code.");
      }
      lastPairingRequests.set(id, now);
    }
    pairingTasks.set(id, true);
    let completed = false;
    try {
      await client[method](phoneNumber);
      completed = true;
      if (clients[id] !== client || recovery.active || callDeliveryStopped) {
        throw new PairingActionError(409, "pairing_changed", "The pairing session changed. Refresh the page before trying again.");
      }
    } catch (error) {
      // Only generated codes count toward the cooldown, so a failed request can be retried at once.
      if (!completed && method === "requestPairingCode") lastPairingRequests.delete(id);
      if (error instanceof PairingActionError) throw error;
      throw new PairingActionError(502, "pairing_failed", "The pairing request failed. Refresh the page and try again.");
    } finally {
      pairingTasks.delete(id);
    }
  };

  /** Generate an account-specific phone code after the user submits its phone number. */
  const requestPairingCode = (clientId, phoneNumber) => runPairingAction(clientId, "requestPairingCode", phoneNumber);

  /** Return one unpaired account to a fresh QR handshake. */
  const useQrPairing = (clientId) => runPairingAction(clientId, "useQrPairing");

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

  // logFields describe the event in warnings without identifiers.
  const deliverCallEvent = async (clientId, eventType, payload, logFields) => {
    for (let attempt = 1; ; attempt += 1) {
      if (callDeliveryStopped) return { delivered: false, attempt: 0 };

      const result = await requestSupervisor(
        `/core/api/events/${eventType}`,
        { clientId, ...payload },
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
            ...logFields,
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
        ...logFields,
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
      pairingCode: null,
      pairingPending: false,
      pairingMethod: "qr",
    });
    logger.info?.("WhatsApp client connected.", {
      runId,
      clientRef: logRef(clientId),
    });
    diagnostics?.recordConnection?.("connected");
    void syncPairingNotification(clientId);
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
        pairingCode: null,
        pairingPending: false,
        pairingMethod: "qr",
      });

      void syncPairingNotification(clientId);
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
      pairingCode: null,
      pairingPending: false,
    });
    void syncPairingNotification(clientId);
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

  const deliverMessage = (message, clientId, eventType) => postSupervisor(
      `/core/api/events/${eventType}`,
      { clientId, ...message },
      "message event delivery"
    ).then((delivered) => {
      diagnostics?.recordMessageDelivered?.(delivered);
      if (!delivered || !debugEnabled) return;
      logger.debug?.("WhatsApp message event delivered.", {
        runId,
        eventType,
        clientRef: logRef(clientId),
        type: safeMessageType(message.type),
        messageRef: logRef(message?.key?.id),
        chatRef: logRef(message?.key?.remoteJid),
      });
    });

  const onMsg = (message, clientId, eventType) => {
    if (messageInbox && inboxClients.includes(clientId) && eventType === "new_whatsapp_message") {
      const task = Promise.resolve().then(() => messageInbox.enqueue(clientId, message)).then(() => scheduleInbox(0)).catch(() => {
        logger.error?.("WhatsApp inbox could not accept a message. Attempting live delivery; storage recovery will retry automatically.");
        scheduleInbox(10000);
        return deliverLive(message, clientId, eventType);
      });
      inboxWrites.add(task);
      void task.then(() => inboxWrites.delete(task), () => inboxWrites.delete(task));
      return;
    }
    void deliverLive(message, clientId, eventType);
  };

  /** Preserve the existing event path for accounts outside the persistent inbox. */
  const deliverLive = async (message, clientId, eventType) => {
    if (!mediaStore || eventType !== "new_whatsapp_message") {
      return deliverMessage(message, clientId, eventType);
    }
    return mediaStore.enrich(message, clients[clientId]).then((media) => {
      if (media?.status === "error") {
        logger.warn?.("WhatsApp incoming media could not be saved.", {
          error: media.error,
          clientRef: logRef(clientId),
        });
      }
      return deliverMessage(media ? { ...message, media } : message, clientId, eventType);
    });
  };

  const inboxWrites = new Set();
  let inboxStopped = false;
  let inboxTimer;
  let inboxDelivery;
  let inboxBusy = false;
  let inboxStorageWarning = false;
  const inboxMedia = new Map();
  /** Wait for WhatsApp only when this message needs an attachment downloaded. */
  const inboxEligible = (id, payload) => {
    if (!inboxClients.includes(id)) return false;
    if (!mediaStore || mediaStore.enabled === false || typeof payload.message.conversation === "string" ||
        typeof payload.message.extendedTextMessage?.text === "string") return true;
    const client = clients[id];
    if (!client) return false;
    try { return !client.getMediaContent(payload) || client.status?.connected === true; }
    catch { return client.status?.connected === true; }
  };
  /** Reuse verified downloads until acknowledgement, expiry or external removal. */
  const inboxAttachment = async (entry) => {
    const cached = inboxMedia.get(entry.id);
    if (cached && Date.parse(cached.expires_at) > Date.now() + 60000) {
      try {
        const stat = await fsPromises.stat(cached.local_path);
        if (stat.isFile() && stat.size === cached.size) return cached;
      } catch { /* Download a replacement for an expired or removed file. */ }
    }
    inboxMedia.delete(entry.id);
    const media = await mediaStore?.enrich(entry.payload, clients[entry.clientId]);
    if (media?.status === "ready") inboxMedia.set(entry.id, media);
    return media;
  };
  /** Deliver immediately; only unavailable receivers or storage incur backoff. */
  const deliverInbox = async () => {
    try {
      if (messageInbox.failed) await messageInbox.start();
      inboxStorageWarning = false;
      const pending = new Set(messageInbox.state.pending.map((entry) => entry.id));
      for (const id of inboxMedia.keys()) if (!pending.has(id)) inboxMedia.delete(id);
      const entry = messageInbox.peek(inboxEligible);
      if (!entry) return pending.size ? 10000 : null;
      const ready = await httpClient.get("http://supervisor/core/api/whatsapp/inbox", {
        headers: supervisorHeaders, timeout: 10000,
      });
      if (ready.data?.ready !== true || inboxStopped) return 10000;
      const media = await inboxAttachment(entry);
      if (inboxStopped || media?.error === "stopped") return null;
      const result = await requestSupervisor("/core/api/whatsapp/inbox", {
        id: entry.id, message: { ...entry.payload, ...(media ? { media } : {}), clientId: entry.clientId },
      }, 10000);
      diagnostics?.recordMessageDelivered?.(result.delivered);
      if (!result.delivered) return 10000;
      await messageInbox.delivered(entry.id);
      inboxMedia.delete(entry.id);
      return 0;
    } catch {
      if (messageInbox.failed && !inboxStorageWarning) {
        inboxStorageWarning = true;
        logger.error?.("WhatsApp inbox storage is unavailable; delivery will retry automatically.");
      }
      return 10000;
    }
  };
  /** Keep one delivery in flight and wake promptly when an idle inbox receives data. */
  const scheduleInbox = (delay) => {
    if (inboxStopped || inboxBusy || delay === null) return;
    if (inboxTimer !== undefined) {
      if (delay !== 0) return;
      clearTimeoutFn(inboxTimer);
    }
    inboxTimer = setTimeoutFn(() => {
      inboxTimer = undefined;
      if (inboxStopped) return;
      inboxBusy = true;
      inboxDelivery = deliverInbox().then((nextDelay) => {
        inboxBusy = false;
        scheduleInbox(nextDelay);
      });
      return inboxDelivery;
    }, delay);
    inboxTimer.unref?.();
  };
  if (messageInbox) scheduleInbox(0);

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

  // Call updates and call logs share one queue, so a call's log always
  // reaches Home Assistant after its last update.
  const queueCallEvent = (clientId, eventType, payload, logFields, onResult) => {
    if (pendingCallUpdates >= MAX_PENDING_CALL_UPDATES) {
      onResult({ delivered: false, attempt: 0 });
      logger.warn?.(
        "WhatsApp call event dropped because the delivery queue is full.",
        {
          runId,
          clientRef: logRef(clientId),
          ...logFields,
          queueLimit: MAX_PENDING_CALL_UPDATES,
        }
      );
      return;
    }

    pendingCallUpdates += 1;
    const deliveryTask = callDeliveryTail.then(async () => {
      try {
        return await deliverCallEvent(clientId, eventType, payload, logFields);
      } catch {
        logger.warn?.(
          "Home Assistant call event delivery failed unexpectedly.",
          {
            runId,
            clientRef: logRef(clientId),
            ...logFields,
          }
        );
        return { delivered: false, attempt: 0 };
      }
    });
    callDeliveryTail = deliveryTask.then(() => undefined);

    void deliveryTask.then((result) => {
      pendingCallUpdates -= 1;
      onResult(result);
    });
  };

  const callLogTrackers = new Map();
  const callLogTracker = (clientId) => {
    if (!callLogTrackers.has(clientId)) {
      callLogTrackers.set(clientId, createCallLogTracker());
    }
    return callLogTrackers.get(clientId);
  };

  const queueCallLog = (clientId, callLog) => {
    const logFields = {
      callDirection: callLog.direction,
      callResult: callLog.result,
    };
    queueCallEvent(clientId, CALL_LOG_EVENT, callLog, logFields, (result) => {
      diagnostics?.recordCallLogDelivered?.(result.delivered);
      if (!result.delivered) return;
      logger.info?.("WhatsApp call log event delivered.", {
        runId,
        clientRef: logRef(clientId),
        ...logFields,
        attempt: result.attempt,
      });
      if (!debugEnabled) return;
      logger.debug?.("WhatsApp call log event delivered.", {
        runId,
        clientRef: logRef(clientId),
        callRef: logRef(callLog.callId),
        peerRef: callLog.peer ? logRef(callLog.peer) : null,
        ...logFields,
        isVideo: callLog.isVideo,
        durationSeconds: callLog.durationSeconds,
        participantCount: callLog.participants.length,
        isGroup: callLog.groupJid !== null,
      });
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
    const callLog = callLogTracker(clientId).fromCallUpdate(update);
    queueCallEvent(
      clientId,
      CALL_UPDATE_EVENT,
      update,
      { callStatus: update.status },
      (result) => {
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
      }
    );
    if (callLog) queueCallLog(clientId, callLog);
  };

  const onMessageStatus = (status, clientId) => {
    diagnostics?.recordMessageStatus?.();
    void postSupervisor(
      "/core/api/events/whatsapp_message_status",
      { clientId, ...status },
      "message status event delivery"
    );
    if (!debugEnabled) return;
    logger.debug?.("WhatsApp message status received.", {
      runId,
      clientRef: logRef(clientId),
      messageRef: logRef(status.messageId),
      chatRef: logRef(status.chatId),
      participantRef: status.participant ? logRef(status.participant) : null,
      status: status.status,
    });
  };

  const onChatRead = (read, clientId) => {
    diagnostics?.recordChatRead?.();
    void postSupervisor(
      "/core/api/events/whatsapp_chat_read",
      { clientId, ...read },
      "chat read event delivery"
    );
    if (!debugEnabled) return;
    logger.debug?.("WhatsApp chat read on another device.", {
      runId,
      clientRef: logRef(clientId),
      chatRef: logRef(read.chatId),
      status: read.status,
      messageCount: read.messageIds.length,
    });
  };

  const onPresenceUpdate = (presence, clientId) => {
    void postSupervisor(
      "/core/api/events/whatsapp_presence_update",
      { clientId, ...presence },
      "presence event delivery"
    );
  };

  // App-state sync carries the phone's outgoing call history. Everything else
  // here is a debug-only view, with identifiers only as fingerprints.
  const onAppStateSync = (event, clientId) => {
    if (event?.type === "server_sync") {
      diagnostics?.recordAppStateNotification?.();
      if (!debugEnabled) return;
      logger.debug?.("WhatsApp app-state sync notification.", {
        runId,
        clientRef: logRef(clientId),
        collections: event.collections,
      });
      return;
    }
    if (event?.type === "resync") {
      if (!debugEnabled) return;
      logger.debug?.("WhatsApp app-state sync progress.", {
        runId,
        clientRef: logRef(clientId),
        phase: event.phase,
        collection: event.collection,
        version: event.version,
      });
      return;
    }
    if (event?.type !== "action") return;

    // A first sync after pairing replays old call history; report live calls only.
    if (!event.initialSync) {
      const callLog = callLogTracker(clientId).fromCallHistory(
        event.mutation,
        event.self
      );
      if (callLog) queueCallLog(clientId, callLog);
    }

    const summary = summarizeSyncAction(event.mutation, {
      ref: logRef,
      self: event.self,
    });
    if (summary.callLog) {
      diagnostics?.recordCallHistoryEntry?.();
      if (!debugEnabled) return;
      logger.debug?.(
        "WhatsApp call history entry received.",
        JSON.stringify({
          runId,
          clientRef: logRef(clientId),
          initialSync: event.initialSync,
          index: summary.index,
          callLog: summary.callLog,
        })
      );
      return;
    }
    // A first sync after pairing replays every setting; only log live changes.
    if (!debugEnabled || event.initialSync) return;
    logger.debug?.(
      "WhatsApp app-state change received.",
      JSON.stringify({
        runId,
        clientRef: logRef(clientId),
        indexType: summary.indexType,
        actions: summary.actions,
      })
    );
  };

  // const onDecryptionDiagnostic = (diagnostic, clientId) => {
  //   if (!decryptionDiagnosticsEnabled) return;
  //   logger.info?.(
  //     "WhatsApp decryption diagnostic.",
  //     JSON.stringify({ runId, clientId, diagnostic })
  //   );
  // };

  const initClient = (clientId) => {
    if (clients[clientId]) return clients[clientId];

    const sessionPath = resolveSessionPath(dataRoot, clientId);
    setClientState(clientId, { state: "connecting", qrDataUrl: null });

    const client = clientFactory({
      path: sessionPath,
      // decryptionDiagnostics: decryptionDiagnosticsEnabled,
    });
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
    client.on("offline_sync", (report = {}) => {
      const details = {
        runId,
        clientRef: logRef(clientId),
        announced: safeCounts(report?.announced),
        received: safeCounts(report?.received),
      };
      if (report?.phase === "unfinished") {
        logger.warn?.(
          "WhatsApp did not finish sending offline messages; new messages may wait until the next reconnect.",
          { ...details, waitedMs: safeCount(report.waitedMs) }
        );
      } else if (report?.phase === "finished") {
        logger.info?.("WhatsApp offline messages received.", {
          ...details,
          count: safeCount(report.count),
          durationMs: safeCount(report.durationMs),
        });
      }
    });
    client.on("events_released", () => {
      if (!debugEnabled) return;
      logger.debug?.("WhatsApp events held by Baileys were released.", {
        runId,
        clientRef: logRef(clientId),
      });
    });
    client.on("qr", (qr) => onQr(qr, clientId));
    /** Keep codes in the protected pairing UI and notification, never the public status API. */
    client.on("pairing_update", (state) => {
      if (clients[clientId] !== client) return;
      const current = clientStates[clientId]?.state;
      setClientState(clientId, {
        // Phone codes are generated on a fresh socket, after its reconnect replaced the QR state.
        ...(state.method === "phone" && ["connecting", "reconnecting", "restarting", "pairing"].includes(current)
          ? { state: "pairing" } : {}),
        ...(state.method === "qr" && current === "pairing" ? { state: "connecting" } : {}),
        pairingMethod: state.method,
        pairingPending: state.pending === true,
        pairingCode: state.code || null,
        qrDataUrl: null,
      });
      void syncPairingNotification(clientId);
    });
    client.on("ready", () => onReady(clientId));
    client.on("disconnected", (statusCode) =>
      onDisconnected(statusCode, clientId)
    );
    client.on("client_error", (error) => onClientError(error, clientId));
    client.on("msg", (message) =>
      onMsg(message, clientId, "new_whatsapp_message")
    );
    client.on("msg_sent", (message) =>
      onMsg(message, clientId, "whatsapp_message_sent")
    );
    /** Deliver decoded contact batches through the existing Home Assistant event path. */
    client.on("contacts_sync", ({ source, contacts }) => {
      void postSupervisor(
        "/core/api/events/whatsapp_contacts_sync",
        { clientId, source, contacts },
        "contact event delivery",
        CALL_EVENT_REQUEST_TIMEOUT_MS
      );
    });
    client.on("msg_upsert", (upsert) => onMsgUpsert(upsert, clientId));
    client.on("msg_ignored", (ignored) => onIgnoredMsg(ignored, clientId));
    client.on("msg_duplicate", (duplicate) =>
      onDuplicateMsg(duplicate, clientId)
    );
    client.on("msg_dedupe_collision", (collision) =>
      onDedupeCollision(collision, clientId)
    );
    client.on("call_update", (call) => onCallUpdate(call, clientId));
    client.on("app_state_sync", (event) => onAppStateSync(event, clientId));
    client.on("call_rejected", ({ callId } = {}) =>
      callLogTracker(clientId).markDeclined(callId)
    );
    client.on("presence_update", (presence) =>
      onPresenceUpdate(presence, clientId)
    );
    client.on("message_status", (status) => onMessageStatus(status, clientId));
    client.on("chat_read", (read) => onChatRead(read, clientId));
    // client.on("decryption_diagnostic", (diagnostic) =>
    //   onDecryptionDiagnostic(diagnostic, clientId)
    // );
    client.on("logout", () => {
      if (logoutTasks.has(clientId)) return;

      const task = (async () => {
        setClientState(clientId, {
          state: "logged_out",
          disconnectedAt: currentIsoTime(),
          qrDataUrl: null,
          pairingCode: null,
          pairingPending: false,
        });
        void syncPairingNotification(clientId);
        logger.info?.("WhatsApp client logged out; resetting session.", {
          runId,
          clientRef: logRef(clientId),
        });
        diagnostics?.recordConnection?.("logged_out");

        const oldClient = clients[clientId];
        oldClient?.removeAllListeners?.();
        delete clients[clientId];
        await oldClient?.disconnect?.(false);
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

  const stopClient = async (clientId) => {
    const client = clients[clientId];
    if (!client) return;

    client.removeAllListeners?.();
    delete clients[clientId];
    await client.disconnect?.(false);
  };

  const stopAllClients = async () => {
    await Promise.allSettled(
      validatedClientIds.map((clientId) => stopClient(clientId))
    );
  };

  const setRecoveryClientStates = () => {
    for (const clientId of validatedClientIds) {
      setClientState(clientId, {
        state: "recovery_paused",
        disconnectedAt: currentIsoTime(),
        lastErrorCode: null,
        qrDataUrl: null,
        pairingCode: null,
        pairingPending: false,
      });
      // A paused startup has no ready event to clear notifications from the previous run.
      void syncPairingNotification(clientId);
    }
  };

  const reportRecoveryRequired = async () => {
    if (recoveryNotificationSent) return true;
    const delivered = await postSupervisor(
      "/core/api/services/persistent_notification/create",
      {
        title: "WhatsApp add-on paused",
        message:
          "The add-on paused its WhatsApp clients after repeated encryption failures to protect the host. Open the WhatsApp add-on panel to retry or reset and re-pair a client.",
        notification_id: RECOVERY_NOTIFICATION_ID,
      },
      "recovery notification"
    );
    if (delivered) {
      recoveryNotificationSent = true;
      logger.info?.("WhatsApp recovery notification delivered.", { runId });
    }
    return delivered;
  };

  const dismissRecoveryNotification = () =>
    postSupervisor(
      "/core/api/services/persistent_notification/dismiss",
      { notification_id: RECOVERY_NOTIFICATION_ID },
      "recovery notification dismissal"
    );

  const enterRecovery = (summary = {}) => {
    if (recovery.active) return recoveryTask || Promise.resolve();

    const record = createRecoveryRecord(summary, {
      runId,
      now: nowDate,
    });
    try {
      persistRecoveryRecordSyncFn({
        record,
        recoveryPath,
        fsModule,
      });
    } catch {
      logger.error?.("WhatsApp recovery state could not be persisted.", {
        runId,
      });
    }

    Object.assign(recovery, {
      active: true,
      reason: RECOVERY_REASON,
      detectedAt: record?.detected_at || currentIsoTime(),
      failedDecryptMessages: record?.failed_decrypt_messages || 0,
      badMacSessionErrors: record?.bad_mac_session_errors || 0,
      messageCounterSessionErrors:
        record?.message_counter_session_errors || 0,
      operationPending: true,
    });
    setRecoveryClientStates();
    logger.error?.(
      "Repeated WhatsApp encryption failures detected; clients paused to protect the host.",
      {
        runId,
        failedDecryptMessages: recovery.failedDecryptMessages,
        sessionErrors:
          recovery.badMacSessionErrors +
          recovery.messageCounterSessionErrors,
      }
    );

    recoveryTask = (async () => {
      await stopAllClients();
      await reportRecoveryRequired();
    })().finally(() => {
      recovery.operationPending = false;
      recoveryTask = undefined;
    });
    return recoveryTask;
  };

  const requireRecoveryAvailable = () => {
    if (!recovery.active) {
      throw new RecoveryActionError(
        409,
        "recovery_not_active",
        "The add-on is not waiting for recovery."
      );
    }
    if (recovery.operationPending) {
      throw new RecoveryActionError(
        409,
        "recovery_busy",
        "A recovery operation is already in progress."
      );
    }
  };

  const clearRecoveryAndStart = async () => {
    await clearRecoveryRecordFn({ recoveryPath, fsPromises });
    Object.assign(recovery, {
      active: false,
      reason: null,
      detectedAt: null,
      failedDecryptMessages: 0,
      badMacSessionErrors: 0,
      messageCounterSessionErrors: 0,
    });
    recoveryNotificationSent = false;
    try {
      onRecoveryCleared?.();
    } catch {
      // Resetting diagnostic counters is best effort.
    }
    await dismissRecoveryNotification();
    for (const clientId of validatedClientIds) initClient(clientId);
  };

  const retryRecovery = async () => {
    requireRecoveryAvailable();
    recovery.operationPending = true;
    try {
      await stopAllClients();
      await clearRecoveryAndStart();
      logger.info?.("WhatsApp recovery retry started.", { runId });
    } finally {
      recovery.operationPending = false;
    }
  };

  const resetRecoveryClient = async (clientId, confirmation) => {
    requireRecoveryAvailable();
    let normalizedClientId;
    try {
      normalizedClientId = normalizeClientId(clientId);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        throw new RecoveryActionError(
          400,
          "invalid_request",
          "A valid client ID is required."
        );
      }
      throw error;
    }
    if (!validatedClientIds.includes(normalizedClientId)) {
      throw new RecoveryActionError(
        404,
        "client_not_found",
        "The client was not found."
      );
    }
    if (confirmation !== normalizedClientId) {
      throw new RecoveryActionError(
        400,
        "confirmation_required",
        "Type the client ID exactly to confirm the reset."
      );
    }

    recovery.operationPending = true;
    try {
      await stopAllClients();
      await removeSessionDirectory({
        dataRoot,
        clientId: normalizedClientId,
        fsPromises,
      });
      await clearRecoveryAndStart();
      logger.warn?.("WhatsApp client session reset for re-pairing.", {
        runId,
        clientRef: logRef(normalizedClientId),
      });
    } finally {
      recovery.operationPending = false;
    }
  };

  if (recovery.active) {
    setRecoveryClientStates();
  } else {
    for (const clientId of validatedClientIds) initClient(clientId);
  }

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
    configuredClientIds: [...validatedClientIds],
    enterRecovery,
    initClient,
    logoutTasks,
    recovery,
    registerDiscovery,
    requestPairingCode,
    reportRecoveryRequired,
    reportHealthFailure,
    resetRecoveryClient,
    retryRecovery,
    useQrPairing,
    runId,
    stopCallDelivery,
    /** Finish pairing notification cleanup after the account sockets have stopped. */
    async flushPairingNotifications() {
      await Promise.allSettled([...pairingNotifications.values()]);
    },
    /** Stop retries and flush messages received before the clients disconnect. */
    async stopInbox() {
      inboxStopped = true;
      if (inboxTimer !== undefined) clearTimeoutFn(inboxTimer);
      await Promise.allSettled([...inboxWrites, inboxDelivery]);
      await messageInbox?.close();
      inboxMedia.clear();
    },
  };
};

/** Load private app state, start the bridge, and flush pending work on shutdown. */
const startAddon = async ({
  optionsPath = OPTIONS_PATH,
  dataRoot = DATA_ROOT,
  apiPort = API_PORT,
  ingressPort = INGRESS_PORT,
  logger = console,
  fsModule = fs,
  fsPromises = fs.promises,
  optionsLoader = loadOptions,
  apiTokenLoader = loadOrCreateApiToken,
  additionalCapabilities = [],
  listenFn = listen,
  closeServerFn = closeServer,
  diagnosticsFactory = createRuntimeDiagnostics,
  mediaStoreFactory = (options) => new MediaStore(options),
  messageInboxFactory = (options) => new MessageInbox(options),
  replayHealthDiagnosticsFn = replayHealthcheckDiagnostics,
  readRecoveryRecordFn = readRecoveryRecord,
  persistRecoveryRecordSyncFn = persistRecoveryRecordSync,
  clearRecoveryRecordFn = clearRecoveryRecord,
  libsignalFilter,
  healthFailurePath =
    process.env.HA_HEALTH_FAILURE_PATH || DEFAULT_HEALTH_FAILURE_PATH,
  heartbeatPath =
    process.env.HA_RUNTIME_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH,
  recoveryPath =
    process.env.HA_DECRYPT_RECOVERY_PATH || DEFAULT_RECOVERY_PATH,
  runId = createRunId(),
  ...runtimeOptions
} = {}) => {
  const options = await optionsLoader(optionsPath);
  const { clientIds } = options;
  const apiToken = normalizeApiToken(await apiTokenLoader({
    dataRoot, legacyToken: options.apiToken, fsPromises,
  }));
  if (!apiToken) throw new Error("Internal API authentication is required.");
  const logLevel = normalizeLogLevel(options.logLevel);
  // const decryptionDiagnostics = normalizeDecryptionDiagnostics(options.decryptionDiagnostics);
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
  const initialRecoveryRecord = await readRecoveryRecordFn({
    recoveryPath,
    fsPromises,
    logger,
  });
  logger.info?.("WhatsApp add-on runtime starting.", {
    runId: safeRunId,
    logLevel,
    // decryptionDiagnostics,
    clientCount: Array.isArray(clientIds) ? clientIds.length : 0,
  });
  await diagnostics.start?.();

  let runtime;
  let mediaStore;
  let messageInbox;
  let pendingDecryptStorm;
  let apiApp;
  let webUiApp;
  let apiServer;
  let webUiServer;
  const handleDecryptStorm = (summary) => {
    pendingDecryptStorm = summary;
    if (runtime) {
      void runtime.enterRecovery(summary);
      return;
    }

    try {
      persistRecoveryRecordSyncFn({
        record: createRecoveryRecord(summary, {
          runId: safeRunId,
        }),
        recoveryPath,
        fsModule,
      });
    } catch {
      logger.error?.("WhatsApp recovery state could not be persisted.", {
        runId: safeRunId,
      });
    }
  };
  libsignalFilter?.setDecryptStormHandler?.(handleDecryptStorm);
  try {
    if (options.inboxClients?.length) {
      messageInbox = messageInboxFactory({ directory: `${dataRoot}/inbox`, fsPromises, logger });
      try { await messageInbox.start(); }
      catch { logger.error?.("WhatsApp inbox storage is unavailable. Existing files are preserved; recovery will retry automatically."); }
    }
    if (options.mediaOptions) {
      mediaStore = mediaStoreFactory({ ...options.mediaOptions, logger });
      await mediaStore.start();
    }
    runtime = createAddonRuntime({
      clientIds,
      apiToken,
      dataRoot,
      apiPort,
      fsModule,
      fsPromises,
      logger,
      logLevel,
      // decryptionDiagnostics,
      runId: safeRunId,
      diagnostics,
      mediaStore,
      messageInbox,
      inboxClients: options.inboxClients,
      initialRecoveryRecord,
      recoveryPath,
      persistRecoveryRecordSyncFn,
      clearRecoveryRecordFn,
      onRecoveryCleared: () =>
        libsignalFilter?.resetStormDetection?.(),
      ...runtimeOptions,
    });
    if (pendingDecryptStorm) {
      await runtime.enterRecovery(pendingDecryptStorm);
    }
    diagnostics.setClientStateProvider?.(() => runtime.clientStates);

    apiApp = createApiApp({
      clients: runtime.clients,
      clientStates: runtime.clientStates,
      logger,
      sharedSecret: apiToken,
      diagnostics,
      additionalCapabilities,
    });
    webUiApp = createWebUiApp({
      clients: runtime.clients,
      clientStates: runtime.clientStates,
      recovery: runtime.recovery,
      resetRecoveryClient: runtime.resetRecoveryClient,
      retryRecovery: runtime.retryRecovery,
      requestPairingCode: runtime.requestPairingCode,
      useQrPairing: runtime.useQrPairing,
    });

    apiServer = await listenFn(apiApp, apiPort, { apiToken });
    webUiServer = await listenFn(webUiApp, ingressPort);
    diagnostics.markApiReady?.();
  } catch (error) {
    const inboxStop = runtime?.stopInbox();
    await mediaStore?.close();
    await inboxStop;
    if (runtime) {
      await Promise.allSettled(
        Object.values(runtime.clients).map((client) => client.disconnect?.())
      );
      await runtime.stopInbox();
      await runtime.flushPairingNotifications();
    }
    if (apiServer) await closeServerFn(apiServer);
    await diagnostics.stop?.();
    libsignalFilter?.setDecryptStormHandler?.();
    throw error;
  }
  logger.info?.("WhatsApp add-on API started.", { runId: safeRunId });
  logger.info?.("WhatsApp add-on ingress UI started.", { runId: safeRunId });
  await runtime.registerDiscovery();
  if (healthFailureReport) {
    await runtime.reportHealthFailure(healthFailureReport);
  }
  if (runtime.recovery.active) {
    await runtime.reportRecoveryRequired();
  }

  let closeTask;
  const close = () => {
    if (closeTask) return closeTask;
    closeTask = (async () => {
      logger.info?.("WhatsApp add-on runtime shutting down.", {
        runId: safeRunId,
      });
      const callDeliveryTask = runtime.stopCallDelivery?.();
      const inboxStop = runtime.stopInbox();
      await mediaStore?.close();
      await inboxStop;
      await Promise.allSettled([
        ...Object.values(runtime.clients).map((client) =>
          client.disconnect?.()
        ),
        callDeliveryTask,
      ]);
      await runtime.stopInbox();
      await Promise.all([
        runtime.flushPairingNotifications(),
        closeServerFn(apiServer),
        closeServerFn(webUiServer),
      ]);
      await diagnostics.stop?.();
      libsignalFilter?.setDecryptStormHandler?.();
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
  // normalizeDecryptionDiagnostics,
  normalizeLogLevel,
  normalizeCallUpdate,
  parseOptions,
  removeSessionDirectory,
  startAddon,
  summarizeMessageDebug,
};
