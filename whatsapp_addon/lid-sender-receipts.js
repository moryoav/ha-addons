const MAX_TRACKED_MESSAGES = 1024;
// One buffered offline flush can release every tracked message at once, and a
// receipt dropped here leaves its message pending on the server for good.
const MAX_PENDING_RECEIPTS = MAX_TRACKED_MESSAGES;
const METADATA_TTL_MS = 5 * 60 * 1000;
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

/**
 * Experimental, additive workaround for Baileys 6.x sender-receipt LID routing.
 * Does NOT intercept messages, change auth/Signal state, or ACK failed decryptions.
 * Call only when explicitly enabled. State belongs to this socket, never a client ID.
 */
const attachLidSenderReceipts = ({
  socket,
  isCurrent = () => true,
  onDiagnostic,
  now = Date.now,
  maxEntries = MAX_TRACKED_MESSAGES,
  maxPending = MAX_PENDING_RECEIPTS,
  ttlMs = METADATA_TTL_MS,
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
  if (typeof socket.sendNode !== "function") {
    report("unsupported_socket");
    return undefined;
  }
  for (const value of [maxEntries, maxPending, ttlMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Invalid receipt limit.");
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
            records.get(record.key) !== record) continue;
        // Recheck identity; never send receipts belonging to a previous login.
        if (parseLid(socket.user?.lid)?.user !== record.ownUser) continue;
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

  const onRawMessage = (node) => {
    try {
      if (!active() || node?.tag !== "message") return;
      const attrs = node.attrs || {};
      const own = parseLid(socket.user?.lid);
      const sender = parseLid(attrs.from);
      const recipient = parseLid(attrs.recipient);
      const id = attrs.id;
      const ownDevice = /:(\d{1,5})@/.exec(socket.user?.id || "")?.[1];
      if (!own || !sender || !recipient || sender.user !== own.user ||
          attrs.recipient.includes(":") || ownDevice === undefined ||
          sender.device === Number(ownDevice) || attrs.participant != null ||
          attrs.category != null || typeof id !== "string" || !id.length ||
          id.length > 256 || !Array.isArray(node.content)) return;
      if (node.content.some((child) => child?.tag === "unavailable" || child?.tag === "plaintext")) return;
      const encrypted = node.content.filter((child) => child?.tag === "enc");
      if (encrypted.length !== 1) return;
      const enc = encrypted[0];
      if (!["msg", "pkmsg"].includes(enc.attrs?.type) ||
          !(enc.content instanceof Uint8Array) || !enc.content.byteLength) return;

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
        key, id, from: attrs.from, recipient: attrs.recipient, ownUser: own.user,
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

  const onConnection = (update) => {
    if (update?.connection === "close") close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    records.clear();
    queue.length = 0;
    removeListener(socket.ws, "CB:message", onRawMessage);
    removeListener(socket.ev, "messages.upsert", onUpsert);
    removeListener(socket.ev, "connection.update", onConnection);
  };

  socket.ws.on("CB:message", onRawMessage);
  socket.ev.on("messages.upsert", onUpsert);
  socket.ev.on("connection.update", onConnection);
  return {
    close,
    get stats() { return { tracked: records.size, queued: queue.length, closed }; },
  };
};

module.exports = { attachLidSenderReceipts };
