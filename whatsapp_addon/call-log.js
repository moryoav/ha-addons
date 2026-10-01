// Builds whatsapp_call_log events: one per finished call, in either direction.
//
// WhatsApp reports the two directions to a linked device differently:
// - Calls made from the phone never produce call stanzas. The phone shares
//   them afterwards through app-state sync as call-history entries, which
//   carry the result and the duration.
// - Calls received are reported live (offer, ringing, accept, reject,
//   timeout, terminate), but never as call-history entries. Once a call is
//   answered elsewhere the linked device hears nothing more, so the end and
//   the duration of an answered call are unknown.

const { CALL_RESULTS, enumName, safeInteger } = require("./app-state-sync");

const CALL_LOG_EVENT = "whatsapp_call_log";
const DEFAULT_PENDING_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING = 100;
const DEFAULT_MAX_REMEMBERED = 1_000;
// Seconds; rejects values past the year 2100.
const MAX_UNIX_SECONDS = 4_102_444_800;

const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const USER_JID_PATTERN =
  /^(?:[1-9]\d{4,14}(?::\d{1,4})?@s\.whatsapp\.net|[1-9]\d{4,30}(?::\d{1,4})?@lid)$/;
const GROUP_JID_PATTERN = /^\d[\d-]{3,62}\d@g\.us$/;
// A call-history entry the phone may still update.
const UNFINISHED_RESULTS = new Set(["ongoing", "upcoming"]);

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const optionalMatch = (value, pattern) =>
  typeof value === "string" && pattern.test(value) ? value : null;

const userPart = (jid) =>
  typeof jid === "string" ? jid.split("@")[0].split(":")[0] : undefined;

const isoFromSeconds = (value) => {
  const seconds = safeInteger(value);
  return seconds !== null && seconds > 0 && seconds <= MAX_UNIX_SECONDS
    ? new Date(seconds * 1000).toISOString()
    : null;
};

/**
 * Reduces an outgoing call-history entry to the event payload. Returns
 * undefined for entries that are incoming, unfinished, or malformed.
 */
const callLogFromHistory = (mutation, self = {}) => {
  const record = mutation?.syncAction?.value?.callLogAction?.callLogRecord;
  if (!isPlainObject(record) || record.isIncoming !== false) return undefined;

  const callId = optionalMatch(record.callId, CALL_ID_PATTERN);
  const result = enumName(CALL_RESULTS, record.callResult);
  if (!callId || result === null || UNFINISHED_RESULTS.has(result)) {
    return undefined;
  }

  const own = new Set([self.id, self.lid].map(userPart).filter(Boolean));
  const participants = (Array.isArray(record.participants)
    ? record.participants
    : []
  )
    .slice(0, 32)
    .map((participant) => ({
      jid: optionalMatch(participant?.userJid, USER_JID_PATTERN),
      result: enumName(CALL_RESULTS, participant?.callResult),
    }));
  const peer = participants.find(
    (participant) => participant.jid && !own.has(userPart(participant.jid))
  );

  return {
    callId,
    direction: "outgoing",
    result,
    isVideo: typeof record.isVideo === "boolean" ? record.isVideo : null,
    durationSeconds: safeInteger(record.duration),
    startedAt: isoFromSeconds(record.startTime),
    peer: peer?.jid ?? null,
    participants,
    groupJid: optionalMatch(record.groupJid, GROUP_JID_PATTERN),
  };
};

/**
 * Follows calls for one WhatsApp client and returns a call-log payload once
 * per finished call. Incoming calls are tracked from their live updates;
 * outgoing calls come from call history. A call is reported at most once.
 */
const createCallLogTracker = ({
  now = Date.now,
  pendingTtlMs = DEFAULT_PENDING_TTL_MS,
  maxPending = DEFAULT_MAX_PENDING,
  maxRemembered = DEFAULT_MAX_REMEMBERED,
} = {}) => {
  const pending = new Map();
  const reported = new Set();

  const remember = (callId) => {
    reported.add(callId);
    if (reported.size > maxRemembered) {
      reported.delete(reported.values().next().value);
    }
  };

  // A call whose ending never arrives, for example across a reconnect, is
  // forgotten rather than reported with a guessed result.
  const prune = () => {
    const cutoff = now() - pendingTtlMs;
    for (const [callId, call] of pending) {
      if (call.seenAt > cutoff) break;
      pending.delete(callId);
    }
  };

  const fromCallUpdate = (update) => {
    const callId = optionalMatch(update?.callId, CALL_ID_PATTERN);
    if (!callId || reported.has(callId)) return undefined;
    prune();

    if (update.status === "offer") {
      if (pending.has(callId)) return undefined;
      if (pending.size >= maxPending) {
        pending.delete(pending.keys().next().value);
      }
      pending.set(callId, {
        seenAt: now(),
        peer: update.from ?? null,
        isVideo: typeof update.isVideo === "boolean" ? update.isVideo : null,
        startedAt: update.date ?? null,
        groupJid: update.groupJid ?? null,
        answered: false,
        declined: false,
      });
      return undefined;
    }

    const call = pending.get(callId);
    if (!call) return undefined;
    if (update.status === "accept") {
      call.answered = true;
      return undefined;
    }
    if (!["reject", "timeout", "terminate"].includes(update.status)) {
      return undefined;
    }

    pending.delete(callId);
    remember(callId);
    let result = "missed";
    if (update.status === "reject" || call.declined) result = "declined";
    else if (call.answered && update.status === "terminate") result = "answered";
    return {
      callId,
      direction: "incoming",
      result,
      isVideo: call.isVideo,
      durationSeconds: null,
      startedAt: call.startedAt,
      peer: call.peer,
      participants: [],
      groupJid: call.groupJid,
    };
  };

  // whatsapp.reject_call declines a call without a reject update of its own;
  // WhatsApp only follows with terminate.
  const markDeclined = (callId) => {
    const call = pending.get(callId);
    if (call) call.declined = true;
  };

  const fromCallHistory = (mutation, self) => {
    const payload = callLogFromHistory(mutation, self);
    if (!payload || reported.has(payload.callId)) return undefined;
    remember(payload.callId);
    return payload;
  };

  return { fromCallHistory, fromCallUpdate, markDeclined };
};

module.exports = {
  CALL_LOG_EVENT,
  callLogFromHistory,
  createCallLogTracker,
};
