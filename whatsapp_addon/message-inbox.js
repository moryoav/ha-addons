const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CAPABILITY = "message_inbox";
const SESSION = /^[a-f0-9]{32}$/;
const IDENTIFIER = /^[a-f0-9]{64}$/;
const STATES = new Set(["pending", "processing", "interrupted", "completed"]);
const wireValue = (_, value) => {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return { type: "Buffer", data: [...value] };
  return value;
};
const mediaValue = (_, value) => {
  if (value?.type === "Buffer" && Array.isArray(value.data) &&
      value.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Buffer.from(value.data);
  }
  return value;
};
const messageId = (clientId, message) => crypto.createHash("sha256")
  .update(JSON.stringify([clientId, message?.key?.remoteJid, message?.key?.id]))
  .digest("hex");

class InboxError extends Error {
  constructor(code, status = 409) {
    super("The message inbox request could not be completed.");
    this.code = code;
    this.status = status;
  }
}

/** Private bounded inbox. Publish state only after the replacement is durable. */
class MessageInbox {
  constructor({ directory, clientIds = [], now = Date.now, fsPromises = fs.promises,
    maxPending = 1000, maxBytes = 32 * 1024 * 1024, maxMessageBytes = 1024 * 1024,
    maxReceipts = 10000, receiptRetentionMs = 7 * 86400000 } = {}) {
    Object.assign(this, { directory, now, fsPromises, maxPending, maxBytes,
      maxMessageBytes, maxReceipts, receiptRetentionMs });
    this.clients = new Set(clientIds);
    this.file = path.join(directory, "messages.json");
    this.state = { version: 1, sequence: 0, session: null, entries: [] };
    this.tail = Promise.resolve();
    this.storageFailed = false;
  }

  enabled(clientId) { return this.clients.has(clientId); }

  async start() {
    try {
      await this.fsPromises.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await this.fsPromises.lstat(this.directory)).isSymbolicLink()) throw new Error();
      await this.fsPromises.chmod(this.directory, 0o700);
      let stored;
      try {
        const stat = await this.fsPromises.lstat(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes) throw new Error();
        await this.fsPromises.chmod(this.file, 0o600);
        stored = JSON.parse(await this.fsPromises.readFile(this.file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (stored) {
        if (stored.version !== 1 || !Number.isSafeInteger(stored.sequence) || stored.sequence < 0 ||
            !(stored.session === null || SESSION.test(stored.session)) || !Array.isArray(stored.entries)) throw new Error();
        const ids = new Set();
        let previous = 0;
        for (const entry of stored.entries) {
          if (!IDENTIFIER.test(entry.id) || !IDENTIFIER.test(entry.receipt) || ids.has(entry.id) ||
              !STATES.has(entry.status) || !Number.isSafeInteger(entry.sequence) ||
              entry.sequence <= previous || entry.sequence > stored.sequence ||
              typeof entry.clientId !== "string" || typeof entry.chatId !== "string" ||
              typeof entry.messageId !== "string" || !Number.isFinite(entry.receivedAt) ||
              typeof entry.ready !== "boolean" ||
              (entry.status !== "completed" && (!entry.payload ||
                messageId(entry.clientId, entry.payload) !== entry.id)) ||
              (["processing", "interrupted"].includes(entry.status) && !SESSION.test(entry.session))) throw new Error();
          ids.add(entry.id); previous = entry.sequence;
        }
        this.state = stored;
      }
      // A process restart cannot prove whether a previously started action finished.
      await this.transaction((state) => {
        for (const entry of state.entries) {
          if (entry.status === "processing") entry.status = "interrupted";
        }
      });
      return this;
    } catch {
      throw new InboxError("inbox_storage_unavailable", 503);
    }
  }

  exclusive(callback) {
    const task = this.tail.then(callback);
    this.tail = task.catch(() => {});
    return task;
  }

  prune(state) {
    const receipts = state.entries.filter((entry) => entry.status === "completed" &&
      entry.completedAt > this.now() - this.receiptRetentionMs).slice(-this.maxReceipts);
    const keep = new Set(receipts.map((entry) => entry.id));
    state.entries = state.entries.filter((entry) => entry.status !== "completed" || keep.has(entry.id));
  }

  async transaction(change) {
    return this.exclusive(async () => {
      if (this.storageFailed) throw new InboxError("inbox_storage_unavailable", 503);
      const next = structuredClone(this.state);
      const result = await change(next);
      this.prune(next);
      const data = JSON.stringify(next);
      if (Buffer.byteLength(data) > this.maxBytes) throw new InboxError("inbox_full", 507);
      if (data === JSON.stringify(this.state)) return result;
      const temporary = path.join(this.directory, `.pending-${crypto.randomUUID()}`);
      let handle;
      let published = false;
      try {
        handle = await this.fsPromises.open(temporary, "wx", 0o600);
        await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null;
        await this.fsPromises.rename(temporary, this.file);
        published = true;
        await this.syncDirectory();
        this.state = next;
      } catch {
        // The file may already contain the new state. Never overwrite it from
        // stale memory after an uncertain directory flush; reload it on restart.
        if (published) this.storageFailed = true;
        throw new InboxError("inbox_storage_unavailable", 503);
      } finally {
        await handle?.close().catch(() => {});
        await this.fsPromises.unlink(temporary).catch(() => {});
      }
      return result;
    });
  }

  async syncDirectory() {
    if (process.platform === "win32") return;
    const directory = await this.fsPromises.open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async enqueue(clientId, payload) {
    if (!this.enabled(clientId)) throw new InboxError("inbox_disabled", 400);
    if (!payload?.key?.id || typeof payload.key.id !== "string" ||
        typeof payload.key.remoteJid !== "string" || !payload.key.remoteJid ||
        payload.key.fromMe !== false || !payload.message || typeof payload.message !== "object") {
      throw new InboxError("invalid_inbox_message", 400);
    }
    // Baileys timestamps may be Long/BigInt; persist the JSON wire representation.
    let wire;
    try { wire = JSON.stringify(payload, wireValue); }
    catch { throw new InboxError("invalid_inbox_message", 400); }
    if (Buffer.byteLength(wire) > this.maxMessageBytes) throw new InboxError("inbox_message_too_large", 413);
    const id = messageId(clientId, payload);
    return this.transaction((state) => {
      if (state.entries.some((entry) => entry.id === id)) return null;
      if (state.entries.filter((entry) => entry.status !== "completed").length >= this.maxPending) {
        throw new InboxError("inbox_full", 507);
      }
      state.entries.push({ id, receipt: crypto.randomBytes(32).toString("hex"),
        clientId, chatId: payload.key.remoteJid, messageId: payload.key.id,
        receivedAt: this.now(), sequence: ++state.sequence, status: "pending",
        ready: false, payload: JSON.parse(wire) });
      return id;
    });
  }

  unready(clientId) {
    return this.state.entries.filter((entry) => entry.status === "pending" && !entry.ready &&
      entry.clientId === clientId).map((entry) => ({ ...structuredClone(entry),
        payload: JSON.parse(JSON.stringify(entry.payload), mediaValue) }));
  }

  ready(id, media) {
    return this.transaction((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry || entry.status !== "pending" || entry.ready) return;
      if (media) entry.payload.media = structuredClone(media);
      entry.ready = true;
    });
  }

  isMediaPinned(id) {
    return this.state.entries.some((entry) => entry.status !== "completed" && entry.payload?.media?.id === id);
  }

  open(session) {
    if (!SESSION.test(session)) throw new InboxError("invalid_inbox_session", 400);
    return this.transaction((state) => {
      if (state.session !== session) {
        for (const entry of state.entries) {
          if (entry.status === "processing") entry.status = "interrupted";
        }
        state.session = session;
      }
      return { status: "ready", clients: [...this.clients] };
    });
  }

  async poll(session, renewMedia, clientReady = () => true) {
    return this.transaction(async (state) => {
      if (!SESSION.test(session) || state.session !== session) throw new InboxError("inbox_session_changed");
      const active = state.entries.filter((entry) => entry.status !== "completed" && this.enabled(entry.clientId));
      const counts = { pending: 0, processing: 0, interrupted: 0 };
      for (const entry of active) counts[entry.status]++;
      const entry = active[0];
      if (!entry) return { status: "empty", counts };
      const inbox = { id: entry.id, receipt: entry.receipt, session,
        received_at: new Date(entry.receivedAt).toISOString() };
      if (entry.status !== "pending" || !entry.ready || !clientReady(entry.clientId)) {
        return { status: entry.status === "pending" ? "preparing" : entry.status, counts, inbox };
      }
      if (entry.payload.media?.status === "ready" && renewMedia) {
        const media = await renewMedia(entry.payload.media);
        if (media?.status !== "ready") {
          // Keep the original UUID pinned and retry later. Do not start a
          // workflow with a transient storage failure in place of its audio.
          return { status: "preparing", counts, inbox, error: "inbox_media_unavailable" };
        }
        entry.payload.media = media;
      }
      return { status: "pending", counts, message: { ...structuredClone(entry.payload), clientId: entry.clientId, inbox } };
    });
  }

  reference(state, reference) {
    if (!reference || !IDENTIFIER.test(reference.id) || !IDENTIFIER.test(reference.receipt) ||
        !SESSION.test(reference.session) || state.session !== reference.session) throw new InboxError("invalid_inbox_reference", 400);
    const entry = state.entries.find((item) => item.id === reference.id && item.receipt === reference.receipt);
    if (!entry || !this.enabled(entry.clientId)) throw new InboxError("inbox_message_not_found", 404);
    return entry;
  }

  begin(reference) {
    return this.transaction((state) => {
      const entry = this.reference(state, reference);
      if (entry.status !== "pending" || !entry.ready) return { started: false, status: entry.status };
      const oldest = state.entries.find((item) => item.status !== "completed" && this.enabled(item.clientId));
      if (oldest?.id !== entry.id) throw new InboxError("inbox_message_out_of_order");
      entry.status = "processing"; entry.session = reference.session;
      return { started: true, status: "processing" };
    });
  }

  complete(reference) {
    return this.transaction((state) => {
      const entry = this.reference(state, reference);
      if (entry.status === "completed") return { status: "completed" };
      if (!["processing", "interrupted"].includes(entry.status) || entry.session !== reference.session) {
        throw new InboxError("inbox_message_not_started");
      }
      entry.status = "completed"; entry.completedAt = this.now();
      delete entry.payload;
      return { status: "completed" };
    });
  }

  resolve(reference, resolution) {
    return this.transaction((state) => {
      const entry = this.reference(state, reference);
      if (entry.status !== "interrupted" || !["retry", "discard"].includes(resolution)) {
        throw new InboxError("invalid_inbox_resolution", 400);
      }
      if (resolution === "discard") {
        entry.status = "completed"; entry.completedAt = this.now(); delete entry.payload;
      } else {
        entry.status = "pending"; entry.receipt = crypto.randomBytes(32).toString("hex"); delete entry.session;
      }
      return { status: entry.status };
    });
  }

  async close() { await this.tail; }
}

module.exports = { CAPABILITY, InboxError, MessageInbox };
