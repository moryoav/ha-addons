// Observes WhatsApp app-state sync, the channel a linked device uses to learn
// about changes made on the phone, such as archived chats or the call history.
// Baileys 6.7.23 decodes these changes but ignores call-history entries
// (callLogAction), so they are only visible through its logger. Everything
// here is diagnostic: it never changes what Baileys does with the data.

const COLLECTION_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ACTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const INDEX_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const JID_PATTERN = /^([^@:\s]{1,64})(?::\d{1,4})?@([a-z.]{1,32})$/;
const MAX_COLLECTIONS = 16;
const MAX_INDEX_ITEMS = 8;
const MAX_PARTICIPANTS = 32;
const MAX_ACTIONS = 16;

// Enum names from the CallLogRecord protobuf bundled with Baileys 6.7.23.
const CALL_RESULTS = [
  "connected",
  "rejected",
  "cancelled",
  "accepted_elsewhere",
  "missed",
  "invalid",
  "unavailable",
  "upcoming",
  "failed",
  "abandoned",
  "ongoing",
];
const CALL_TYPES = ["regular", "scheduled_call", "voice_chat"];
const SILENCE_REASONS = ["none", "scheduled", "privacy", "lightweight"];

const RESYNC_MESSAGES = [
  [/^resyncing ([a-z0-9_]{1,64}) from v(\d{1,15})$/, "started"],
  [/^synced ([a-z0-9_]{1,64}) to v(\d{1,15})$/, "synced"],
  [/^restored state of ([a-z0-9_]{1,64}) from snapshot to v(\d{1,15})/, "restored"],
];
const RESYNC_FAILED_PREFIX = "failed to sync state from version";
const SYNC_ACTION_MESSAGE = "processing sync action";
const LOGGER_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const safeInteger = (value) => {
  if (value === undefined || value === null) return null;
  const number =
    typeof value === "object" && typeof value.toNumber === "function"
      ? value.toNumber()
      : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const optionalBoolean = (value) => (typeof value === "boolean" ? value : null);

const enumName = (names, value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const name = value.toLowerCase();
    return names.includes(name) ? name : "unknown";
  }
  return Number.isInteger(value) && names[value] ? names[value] : "unknown";
};

const userPart = (jid) =>
  typeof jid === "string" ? jid.match(JID_PATTERN)?.[1] : undefined;

/**
 * Describes an identifier without revealing it: its kind, whether it is the
 * linked account itself, and a keyed fingerprint so entries can be compared.
 */
const describeJid = (value, { ref, self } = {}) => {
  if (typeof value !== "string" || value === "") return null;
  const match = value.match(JID_PATTERN);
  if (!match) return { kind: "unknown" };
  const [, user, server] = match;
  const kind =
    { "s.whatsapp.net": "pn", lid: "lid", "g.us": "group", "call": "call" }[
      server
    ] || "other";
  const own = [self?.id, self?.lid].map(userPart).filter(Boolean);
  return {
    kind,
    self: own.includes(user),
    ref: typeof ref === "function" ? ref(`${user}@${server}`) : undefined,
  };
};

const describeIndexItem = (value, position, options) => {
  if (typeof value !== "string") return "missing";
  if (position === 0 && INDEX_TYPE_PATTERN.test(value)) return value;
  if (value === "0" || value === "1") return `flag:${value}`;
  if (JID_PATTERN.test(value)) return describeJid(value, options);
  return "value";
};

const summarizeCallLogRecord = (record, options = {}) => {
  if (!isPlainObject(record)) return { malformed: true };
  const participants = Array.isArray(record.participants)
    ? record.participants
    : [];
  return {
    result: enumName(CALL_RESULTS, record.callResult),
    isIncoming: optionalBoolean(record.isIncoming),
    isVideo: optionalBoolean(record.isVideo),
    isCallLink: optionalBoolean(record.isCallLink),
    isDndMode: optionalBoolean(record.isDndMode),
    callType: enumName(CALL_TYPES, record.callType),
    silenceReason: enumName(SILENCE_REASONS, record.silenceReason),
    durationSeconds: safeInteger(record.duration),
    startTime: safeInteger(record.startTime),
    callRef:
      typeof record.callId === "string" && record.callId &&
      typeof options.ref === "function"
        ? options.ref(record.callId)
        : null,
    creator: describeJid(record.callCreatorJid, options),
    group: describeJid(record.groupJid, options),
    hasCallLinkToken: typeof record.callLinkToken === "string" && !!record.callLinkToken,
    hasScheduledCallId:
      typeof record.scheduledCallId === "string" && !!record.scheduledCallId,
    participantCount: participants.length,
    participants: participants.slice(0, MAX_PARTICIPANTS).map((participant) => ({
      ...(describeJid(participant?.userJid, options) || { kind: "missing" }),
      result: enumName(CALL_RESULTS, participant?.callResult),
    })),
  };
};

/**
 * Reduces one decoded app-state mutation to its shape: the index type, which
 * action fields are set, and, for call-history entries, a call summary.
 */
const summarizeSyncAction = (mutation, options = {}) => {
  const index = Array.isArray(mutation?.index) ? mutation.index : [];
  const value = mutation?.syncAction?.value;
  const actions = isPlainObject(value)
    ? Object.keys(value)
        .filter(
          (name) =>
            name !== "timestamp" &&
            ACTION_NAME_PATTERN.test(name) &&
            value[name] !== null &&
            value[name] !== undefined
        )
        .slice(0, MAX_ACTIONS)
    : [];
  const summary = {
    indexType:
      typeof index[0] === "string" && INDEX_TYPE_PATTERN.test(index[0])
        ? index[0]
        : null,
    index: index
      .slice(0, MAX_INDEX_ITEMS)
      .map((item, position) => describeIndexItem(item, position, options)),
    actions,
  };
  if (actions.includes("callLogAction")) {
    summary.callLog = summarizeCallLogRecord(
      value.callLogAction?.callLogRecord,
      options
    );
  }
  return summary;
};

const normalizeLoggerArgs = (args) => {
  const [first, second] = args;
  if (typeof first === "string") return { message: first, details: undefined };
  return {
    message: typeof second === "string" ? second : undefined,
    details: first,
  };
};

const observeLog = (args, onEvent) => {
  const { message, details } = normalizeLoggerArgs(args);
  if (typeof message !== "string") return;
  if (message === SYNC_ACTION_MESSAGE) {
    if (isPlainObject(details?.syncAction)) {
      onEvent({
        type: "action",
        mutation: details.syncAction,
        initialSync: details.initialSync === true,
      });
    }
    return;
  }
  if (message.startsWith(RESYNC_FAILED_PREFIX)) {
    const collection = details?.name;
    onEvent({
      type: "resync",
      phase: "failed",
      collection:
        typeof collection === "string" && COLLECTION_PATTERN.test(collection)
          ? collection
          : null,
      version: null,
    });
    return;
  }
  for (const [pattern, phase] of RESYNC_MESSAGES) {
    const match = message.match(pattern);
    if (match) {
      onEvent({
        type: "resync",
        phase,
        collection: match[1],
        version: safeInteger(match[2]),
      });
      return;
    }
  }
};

/**
 * Wraps the logger handed to Baileys so app-state progress and decoded changes
 * can be observed. Every call is still forwarded unchanged, and the level is
 * the wrapped logger's own so Baileys' verbose frame logging stays off.
 */
const createAppStateLogger = (logger, onEvent) => {
  const wrapper = {
    child(bindings) {
      return createAppStateLogger(logger.child(bindings), onEvent);
    },
  };
  Object.defineProperty(wrapper, "level", {
    enumerable: true,
    get: () => logger.level,
    set: (level) => {
      logger.level = level;
    },
  });
  for (const level of LOGGER_LEVELS) {
    wrapper[level] = (...args) => {
      try {
        observeLog(args, onEvent);
      } catch {
        // Observing must never interrupt Baileys.
      }
      return logger[level]?.(...args);
    };
  }
  return wrapper;
};

/**
 * Reports each server_sync notification: WhatsApp's signal that an app-state
 * collection changed. Only the collection names are kept.
 */
const attachServerSyncMonitor = ({ socket, onReport }) => {
  const ws = socket?.ws;
  const ev = socket?.ev;
  if (typeof ws?.on !== "function" || typeof ev?.on !== "function") {
    return undefined;
  }
  let closed = false;

  const onFrame = (frame) => {
    try {
      if (
        closed ||
        frame?.tag !== "notification" ||
        frame.attrs?.type !== "server_sync"
      ) {
        return;
      }
      const children = Array.isArray(frame.content) ? frame.content : [];
      const collections = children
        .filter((child) => child?.tag === "collection")
        .map((child) => child.attrs?.name)
        .filter(
          (name) => typeof name === "string" && COLLECTION_PATTERN.test(name)
        )
        .slice(0, MAX_COLLECTIONS);
      onReport?.({ type: "server_sync", collections });
    } catch {
      // Malformed frames are Baileys' business, never ours.
    }
  };

  const removeListener = (emitter, event, listener) => {
    if (typeof emitter.off === "function") emitter.off(event, listener);
    else emitter.removeListener?.(event, listener);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    removeListener(ws, "frame", onFrame);
    removeListener(ev, "connection.update", onConnection);
  };

  const onConnection = (update) => {
    if (update?.connection === "close") close();
  };

  ws.on("frame", onFrame);
  ev.on("connection.update", onConnection);
  return { close };
};

module.exports = {
  attachServerSyncMonitor,
  createAppStateLogger,
  describeJid,
  summarizeCallLogRecord,
  summarizeSyncAction,
};
