// Turns Baileys receipt events into two Home Assistant events.
//
// Baileys reports a receipt on a message this account sent as an update with
// key.fromMe true: messages.update for direct chats, and message-receipt.update
// with the reading member for groups. When this account reads or plays
// messages on another device, such as the phone, the same events carry the
// incoming messages instead (key.fromMe false).

// proto.WebMessageInfo.Status values in Baileys 6.7.23.
const MESSAGE_STATUSES = new Map([
  [0, "error"],
  [3, "delivered"],
  [4, "read"],
  [5, "played"],
]);
const READ_STATUSES = new Map([
  [4, "read"],
  [5, "played"],
]);
const STATUS_BROADCAST = "status@broadcast";
const MAX_MESSAGE_IDS = 100;
// Seconds; rejects values past the year 2100.
const MAX_UNIX_SECONDS = 4_102_444_800;

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JID_PATTERN = /^[^\s@:]{1,64}(?::\d{1,4})?@[a-z.]{1,32}$/;

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const validJid = (value) =>
  typeof value === "string" && JID_PATTERN.test(value) ? value : null;

const userPart = (jid) =>
  typeof jid === "string" ? jid.split("@")[0].split(":")[0] : undefined;

const isoFromSeconds = (value) => {
  const seconds =
    typeof value === "object" && typeof value?.toNumber === "function"
      ? value.toNumber()
      : Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_UNIX_SECONDS
    ? new Date(seconds * 1000).toISOString()
    : null;
};

// The chat and message a receipt refers to, or undefined when it is malformed
// or belongs to a status update (story).
const receiptTarget = (key) => {
  if (!isPlainObject(key)) return undefined;
  const chatId = validJid(key.remoteJid);
  const messageId =
    typeof key.id === "string" && MESSAGE_ID_PATTERN.test(key.id) ? key.id : null;
  if (!chatId || !messageId || chatId === STATUS_BROADCAST) return undefined;
  return { chatId, messageId };
};

/**
 * Delivery, read, and played updates for messages this account sent, one per
 * message (and per group member for groups).
 */
const messageStatusesFrom = (event, updates) => {
  const statuses = [];
  for (const entry of Array.isArray(updates) ? updates : []) {
    if (entry?.key?.fromMe !== true) continue;
    const target = receiptTarget(entry.key);
    if (!target) continue;

    if (event === "messages.update") {
      const status = MESSAGE_STATUSES.get(entry.update?.status);
      if (status) {
        statuses.push({ ...target, status, participant: null, timestamp: null });
      }
      continue;
    }

    // Baileys keeps only delivery and read times for group members; a played
    // voice message is reported as read.
    const receipt = entry.receipt;
    const participant = validJid(receipt?.userJid);
    if (!participant) continue;
    const read = isoFromSeconds(receipt.readTimestamp);
    const delivered = isoFromSeconds(receipt.receiptTimestamp);
    if (read || delivered) {
      statuses.push({
        ...target,
        status: read ? "read" : "delivered",
        participant,
        timestamp: read || delivered,
      });
    }
  }
  return statuses;
};

/**
 * Messages this account read or played on another device, grouped per chat
 * and status. Group receipts must name this account as the reader.
 */
const chatReadsFrom = (event, updates, self = {}) => {
  const own = new Set([self.id, self.lid].map(userPart).filter(Boolean));
  const reads = new Map();
  for (const entry of Array.isArray(updates) ? updates : []) {
    if (entry?.key?.fromMe !== false) continue;
    const target = receiptTarget(entry.key);
    if (!target) continue;

    let status;
    if (event === "messages.update") {
      status = READ_STATUSES.get(entry.update?.status);
    } else if (
      own.has(userPart(entry.receipt?.userJid)) &&
      isoFromSeconds(entry.receipt?.readTimestamp)
    ) {
      status = "read";
    }
    if (!status) continue;

    const groupKey = `${target.chatId}\u001f${status}`;
    const read = reads.get(groupKey) || {
      chatId: target.chatId,
      status,
      messageIds: [],
    };
    if (
      read.messageIds.length < MAX_MESSAGE_IDS &&
      !read.messageIds.includes(target.messageId)
    ) {
      read.messageIds.push(target.messageId);
    }
    reads.set(groupKey, read);
  }
  return [...reads.values()];
};

module.exports = {
  chatReadsFrom,
  messageStatusesFrom,
};
