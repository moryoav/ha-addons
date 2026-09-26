const MAX_TRACKED_MESSAGES = 1024;
// One buffered offline flush can release every tracked message at once, and a
// receipt dropped here leaves its message pending on the server for good.
const MAX_PENDING_RECEIPTS = MAX_TRACKED_MESSAGES;
const METADATA_TTL_MS = 5 * 60 * 1000;
const MAX_DELIVERED_MESSAGES = 2048;
const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000;
const LID = /^([1-9]\d{4,30})(?::(\d{1,5}))?@lid$/;

const parseLid = (value) => {
  if (typeof value !== "string") return undefined;
  const match = LID.exec(value);
  if (!match || Number(match[2] || 0) > 65535) return undefined;
  return { user: match[1], device: Number(match[2] || 0) };
};

// The rule Baileys applies to its own receipt: any decoded payload, whatever its
// type. A CIPHERTEXT stub (even beside partial content) is a failed decryption.
// Filtering by content would leave edits, deletions and other control messages
// pending, and those replay into the retry path exactly like text does.
const isDecrypted = (message) =>
  (message.messageStubType == null || message.messageStubType === 0) &&
  message.message != null && typeof message.message === "object" &&
  !Array.isArray(message.message);

const removeListener = (emitter, event, listener) => {
  if (typeof emitter.off === "function") emitter.off(event, listener);
  else emitter.removeListener(event, listener);
};

const validLimit = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * Own-device messages this client already decrypted, kept across reconnects.
 * Holds identifiers only: own LID user, chat LID, message ID and origin device.
 * A later copy of one of these can never be decrypted again (its keys are used).
 */
const createDeliveredMessages = ({
  now = Date.now,
  maxEntries = MAX_DELIVERED_MESSAGES,
  ttlMs = DELIVERED_TTL_MS,
} = {}) => {
  if (!validLimit(maxEntries) || !validLimit(ttlMs)) {
    throw new TypeError("Invalid delivered message limit.");
  }
  const entries = new Map();
  const prune = () => {
    const time = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt > time) break;
      entries.delete(key);
    }
  };
  return {
    add(key, from) {
      prune();
      // Re-insert so insertion order still matches expiry order.
      entries.delete(key);
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(key, { from, expiresAt: now() + ttlMs });
    },
    has(key, from) {
      prune();
      return entries.get(key)?.from === from;
    },
    get size() {
      prune();
      return entries.size;
    },
  };
};

/**
 * Experimental, additive workaround for Baileys 6.x sender-receipt LID routing.
 * Does NOT change auth/Signal state or ACK a message that never decrypted.
 * With `delivered`, a later copy of an own message this client already decrypted
 * is answered here and not passed to Baileys, which could only fail on it.
 * Call only when explicitly enabled. State belongs to this socket; only
 * `delivered` is shared by the sockets of one client.
 */
const attachLidSenderReceipts = ({
  socket,
  isCurrent = () => true,
  onDiagnostic,
  now = Date.now,
  maxEntries = MAX_TRACKED_MESSAGES,
  maxPending = MAX_PENDING_RECEIPTS,
  ttlMs = METADATA_TTL_MS,
  delivered,
}) => {
  const report = (outcome) => {
    try {
      // No message bodies, addresses, IDs, ciphertext, or upstream exception text.
      onDiagnostic?.({ source: "lid_sender_receipts", outcome });
    } catch {
      // Diagnostics must not affect message processing.
    }
  };
  for (const emitter of [socket?.ws, socket?.ev]) {
    if (typeof emitter?.on !== "function" ||
        (typeof emitter.off !== "function" && typeof emitter.removeListener !== "function")) {
      report("unsupported_socket");
      return undefined;
    }
  }
  if (typeof socket.sendNode !== "function" ||
      (delivered !== undefined && typeof socket.ws.emit !== "function")) {
    report("unsupported_socket");
    return undefined;
  }
  for (const value of [maxEntries, maxPending, ttlMs]) {
    if (!validLimit(value)) throw new TypeError("Invalid receipt limit.");
  }
  if (delivered !== undefined &&
      (typeof delivered?.add !== "function" || typeof delivered.has !== "function")) {
    throw new TypeError("Invalid delivered message store.");
  }

  const records = new Map();
  const queue = [];
  let closed = false;
  let draining = false;
  const active = () => {
    try {
      return !closed && isCurrent() && socket.ws.isOpen === true;
    } catch {
      return false;
    }
  };
  const keyFor = (recipient, id) => JSON.stringify([recipient, id]);
  const deliveredKey = (ownUser, recipient, id) => JSON.stringify([ownUser, recipient, id]);
  // Baileys assembles its socket by object spread, which turns `socket.user` into a
  // snapshot taken at creation. Pairing stores no LID; it is first learned at login,
  // and Baileys then replaces `creds.me` rather than updating it. So on the first
  // connection after a pairing only the live credentials ever carry the own LID.
  const me = () => {
    const live = socket.authState?.creds?.me;
    return { id: live?.id ?? socket.user?.id, lid: live?.lid ?? socket.user?.lid };
  };
  const prune = () => {
    const time = now();
    for (const [key, record] of records) {
      if (record.expiresAt > time) break;
      records.delete(key);
    }
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    // Never delay ordinary messages.upsert consumers for our optional network write.
    await Promise.resolve();
    try {
      while (queue.length && active()) {
        const record = queue.shift();
        if (record.ambiguous || record.expiresAt <= now() ||
            (!record.copy && records.get(record.key) !== record)) continue;
        // Recheck identity; never send receipts belonging to a previous login.
        if (parseLid(me().lid)?.user !== record.ownUser) continue;
        try {
          // Bypass sendReceipt(), whose direct-LID branch is defective in 6.x.
          // 'sender' is a linked-device delivery receipt, NOT a 'read' receipt.
          await socket.sendNode({
            tag: "receipt",
            attrs: {
              id: record.id,
              type: "sender",
              to: record.from,
              recipient: record.recipient,
            },
          });
          if (!closed) report("sent");
        } catch {
          if (!closed) report("send_failed");
          // No automatic retry loop. Baileys continues its normal handling.
        }
      }
    } catch {
      if (!closed) report("handler_failed");
    } finally {
      draining = false;
      if (!active()) queue.length = 0;
    }
  };

  // A direct encrypted stanza from another device of this account, or undefined.
  const ownDeviceStanza = (node) => {
    if (node?.tag !== "message") return undefined;
    const attrs = node.attrs || {};
    const own = parseLid(me().lid);
    const sender = parseLid(attrs.from);
    const recipient = parseLid(attrs.recipient);
    const id = attrs.id;
    const ownDevice = /:(\d{1,5})@/.exec(me().id || "")?.[1];
    if (!own || !sender || !recipient || sender.user !== own.user ||
        attrs.recipient.includes(":") || ownDevice === undefined ||
        sender.device === Number(ownDevice) || attrs.participant != null ||
        attrs.category != null || typeof id !== "string" || !id.length ||
        id.length > 256 || !Array.isArray(node.content)) return undefined;
    if (node.content.some((child) => child?.tag === "unavailable" || child?.tag === "plaintext")) {
      return undefined;
    }
    const encrypted = node.content.filter((child) => child?.tag === "enc");
    if (encrypted.length !== 1) return undefined;
    const enc = encrypted[0];
    if (!["msg", "pkmsg"].includes(enc.attrs?.type) ||
        !(enc.content instanceof Uint8Array) || !enc.content.byteLength) return undefined;
    return { attrs, id, ownUser: own.user };
  };

  // Issue #7: a copy of an own message that this client already decrypted can
  // never be decrypted again. Baileys would only fail on it, count errors toward
  // the recovery pause and ask the phone to resend. Answer it with the corrected
  // receipt instead, so it leaves the server queue. Returns true if answered.
  const answerCopy = (node) => {
    if (!delivered || !active()) return false;
    const stanza = ownDeviceStanza(node);
    if (!stanza || !delivered.has(
      deliveredKey(stanza.ownUser, stanza.attrs.recipient, stanza.id), stanza.attrs.from
    )) return false;
    if (queue.length >= maxPending) {
      report("queue_full");
      return false;
    }
    queue.push({
      id: stanza.id, from: stanza.attrs.from, recipient: stanza.attrs.recipient,
      ownUser: stanza.ownUser, expiresAt: now() + ttlMs, ambiguous: false, copy: true,
    });
    report("copy_answered");
    void drain();
    return true;
  };

  const onRawMessage = (node) => {
    try {
      if (!active()) return;
      const stanza = ownDeviceStanza(node);
      if (!stanza) return;
      const { attrs, id } = stanza;

      prune();
      const key = keyFor(attrs.recipient, id);
      const existing = records.get(key);
      if (existing) {
        if (existing.ambiguous) return;
        if (existing.from !== attrs.from) {
          // Two own devices claiming one ID: never guess which one to acknowledge.
          existing.ambiguous = true;
          report("ambiguous");
          return;
        }
        // A redelivery, or the origin device's answer to a Baileys retry request:
        // same ID, usually fresh ciphertext and timestamp. The receipt depends on
        // neither, and only a receipt for this copy lets the message leave the
        // server queue. Re-insert so insertion order still matches expiry order.
        records.delete(key);
        existing.pending += 1;
        existing.expiresAt = now() + ttlMs;
        records.set(key, existing);
        return;
      }
      while (records.size >= maxEntries) records.delete(records.keys().next().value);
      records.set(key, {
        key, id, from: attrs.from, recipient: attrs.recipient, ownUser: stanza.ownUser,
        expiresAt: now() + ttlMs, pending: 1, ambiguous: false,
      });
    } catch {
      report("handler_failed");
    }
  };

  const onUpsert = (upsert) => {
    try {
      if (!active() || !["notify", "append"].includes(upsert?.type) ||
          upsert.requestId != null || !Array.isArray(upsert.messages)) return;
      prune();
      for (const message of upsert.messages) {
        const key = message?.key;
        if (!key || key.fromMe !== true || key.participant != null) continue;
        const record = records.get(keyFor(key.remoteJid, key.id));
        // One receipt per raw copy: a local echo or second consumer earns nothing.
        if (!record || record.ambiguous || record.pending < 1) continue;
        record.pending -= 1;
        // A failed copy only uses up its own turn; a later copy can still succeed.
        if (!isDecrypted(message)) continue;
        delivered?.add(deliveredKey(record.ownUser, record.recipient, record.id), record.from);
        if (queue.length >= maxPending) {
          report("queue_full");
          continue;
        }
        queue.push(record);
      }
      void drain();
    } catch {
      report("handler_failed");
    }
  };

  // Baileys handles every stanza in its own "CB:message" listener, and an event
  // listener cannot stop the others. So a copy is answered where the socket emits
  // it, before any listener runs. Everything else passes through unchanged.
  const ws = socket.ws;
  const baseEmit = ws.emit;
  const hadOwnEmit = Object.prototype.hasOwnProperty.call(ws, "emit");
  const emit = function (event, ...args) {
    if (event === "CB:message") {
      try {
        if (answerCopy(args[0])) return true;
      } catch {
        report("handler_failed");
      }
    }
    return baseEmit.apply(this, [event, ...args]);
  };

  const onConnection = (update) => {
    if (update?.connection === "close") close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    records.clear();
    queue.length = 0;
    if (ws.emit === emit) {
      if (hadOwnEmit) ws.emit = baseEmit;
      else delete ws.emit;
    }
    removeListener(socket.ws, "CB:message", onRawMessage);
    removeListener(socket.ev, "messages.upsert", onUpsert);
    removeListener(socket.ev, "connection.update", onConnection);
  };

  if (delivered) ws.emit = emit;
  socket.ws.on("CB:message", onRawMessage);
  socket.ev.on("messages.upsert", onUpsert);
  socket.ev.on("connection.update", onConnection);
  return {
    close,
    get stats() { return { tracked: records.size, queued: queue.length, closed }; },
  };
};

module.exports = { attachLidSenderReceipts, createDeliveredMessages };
