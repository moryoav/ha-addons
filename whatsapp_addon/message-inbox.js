const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CAPABILITY = "message_inbox";
const SESSION = /^[a-f0-9]{32}$/;
const IDENTIFIER = /^[a-f0-9]{64}$/;
const MEDIA_UUID = /\b[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/gi;
const STATES = new Set(["pending", "processing", "interrupted", "blocked", "completed"]);
const REASONS = new Set(["unclaimed", "preparation_timeout", "processing_timeout",
  "preparation_interrupted", "processing_interrupted", "workflow_failed", "account_disabled"]);
const TRANSIENT_MEDIA = new Set(["timeout", "download_failed", "queue_full",
  "storage_full", "storage_unavailable", "inbox_media_unavailable"]);
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
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
    maxReceipts = 1000, receiptRetentionMs = 7 * 86400000,
    claimTimeoutMs = 60000, preparationTimeoutMs = 15 * 60000,
    processingTimeoutMs = 30 * 60000, preparationRetryMs = 10000,
    maxPreparationAttempts = 3, logger = {} } = {}) {
    Object.assign(this, { directory, now, fsPromises, maxPending, maxBytes,
      maxMessageBytes, maxReceipts, receiptRetentionMs, claimTimeoutMs,
      preparationTimeoutMs, processingTimeoutMs, preparationRetryMs, maxPreparationAttempts, logger });
    this.clients = new Set(clientIds);
    this.file = path.join(directory, "messages.json");
    this.admissionGuards = new Set();
    this.state = { version: 1, sequence: 0, session: null, entries: [] };
    this.serialized = null;
    this.tail = Promise.resolve();
    this.storageFailed = false;
    this.recoveryPins = new Set();
    this.corruptStorage = false;
  }

  enabled(clientId) { return this.clients.has(clientId); }

  markUnavailable(raw) {
    this.storageFailed = true;
    for (const entry of this.state.entries) {
      if (entry.status !== "completed" && typeof entry.payload?.media?.id === "string") this.recoveryPins.add(entry.payload.media.id);
    }
    if (typeof raw === "string") {
      for (const match of raw.matchAll(MEDIA_UUID)) this.recoveryPins.add(match[0].toLowerCase());
    }
  }

  validate(stored) {
    if (!stored || stored.version !== 1 || !Number.isSafeInteger(stored.sequence) || stored.sequence < 0 ||
        !(stored.session === null || matches(SESSION, stored.session)) || !Array.isArray(stored.entries)) throw new Error();
    const ids = new Set();
    let previous = 0;
    for (const entry of stored.entries) {
      if (!entry || !matches(IDENTIFIER, entry.id) || !matches(IDENTIFIER, entry.receipt) || ids.has(entry.id) ||
          !STATES.has(entry.status) || !Number.isSafeInteger(entry.sequence) ||
          entry.sequence <= previous || entry.sequence > stored.sequence ||
          typeof entry.clientId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.clientId) ||
          (entry.reason !== undefined && !REASONS.has(entry.reason)) ||
          (entry.status === "blocked" && !REASONS.has(entry.reason)) ||
          ["offeredAt", "startedAt", "readyAt", "preparationAt", "nextAttemptAt", "mediaWaitAt"].some((key) =>
            entry[key] !== undefined && (!Number.isFinite(entry[key]) || entry[key] < 0))) throw new Error();
      if (entry.status === "completed") {
        if (!Number.isFinite(entry.completedAt) || entry.completedAt < 0) throw new Error();
      } else if (typeof entry.chatId !== "string" || !entry.chatId ||
          typeof entry.messageId !== "string" || !entry.messageId ||
          !Number.isFinite(entry.receivedAt) || entry.receivedAt < 0 || !Number.isFinite(new Date(entry.receivedAt).getTime()) ||
          typeof entry.ready !== "boolean" || !entry.payload || Array.isArray(entry.payload) ||
          !entry.payload.message || typeof entry.payload.message !== "object" || Array.isArray(entry.payload.message) ||
          entry.payload.key?.fromMe !== false || entry.payload.key.id !== entry.messageId ||
          entry.payload.key.remoteJid !== entry.chatId || messageId(entry.clientId, entry.payload) !== entry.id ||
          (entry.status === "processing" && (!entry.ready || entry.session !== stored.session)) ||
          (["processing", "interrupted"].includes(entry.status) && !matches(SESSION, entry.session)) ||
          (entry.attempts !== undefined && (!Number.isSafeInteger(entry.attempts) || entry.attempts < 0))) throw new Error();
      ids.add(entry.id); previous = entry.sequence;
    }
    if (stored.entries.filter((entry) => entry.status !== "completed").length > this.maxPending) throw new Error();
  }

  start() { return this.exclusive(() => this.initialize()); }

  async initialize() {
    let raw;
    this.corruptStorage = false;
    try {
      await this.fsPromises.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await this.fsPromises.lstat(this.directory)).isSymbolicLink()) throw new Error();
      await this.fsPromises.chmod(this.directory, 0o700);
      let stored;
      try {
        const stat = await this.fsPromises.lstat(this.file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        await this.fsPromises.chmod(this.file, 0o600);
        const handle = await this.fsPromises.open(this.file, "r");
        try {
          const buffer = Buffer.alloc(Math.min(stat.size, this.maxBytes + 1));
          let offset = 0;
          while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
          }
          raw = buffer.subarray(0, offset).toString("utf8");
        } finally { await handle.close(); }
        try {
          if (stat.size > this.maxBytes) throw new Error();
          stored = JSON.parse(raw);
          this.validate(stored);
        } catch (error) { this.corruptStorage = true; throw error; }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      this.state = stored || { version: 1, sequence: 0, session: null, entries: [] };
      this.serialized = stored ? JSON.stringify(stored) : null;
      // A new inbox directory must itself survive a crash, not only its files.
      // Read existing references first so a flush error still protects their media.
      await this.syncDirectory(path.dirname(this.directory));
      // The filename records the identity atomically, without parsing a record
      // that a crash could truncate. Only a matching admission can be uncertain.
      this.admissionGuards = new Set((await this.fsPromises.readdir(this.directory))
        .filter((name) => /^\.admission-[a-f0-9]{64}$/.test(name)));
      const uncertainIds = new Set([...this.admissionGuards].map((name) => name.slice(11)));
      this.storageFailed = false;
      const next = { ...this.state, entries: this.state.entries.map((entry) => ({ ...entry })) };
      for (const entry of next.entries) {
        if (entry.status === "interrupted" && !entry.reason) entry.reason = "processing_interrupted";
        if (entry.status === "processing") {
          entry.status = "interrupted"; entry.reason = "processing_interrupted";
        } else if (entry.status === "pending") {
          if (entry.offeredAt !== undefined) entry.receipt = crypto.randomBytes(32).toString("hex");
          delete entry.offeredAt; delete entry.preparationAt; delete entry.mediaWaitAt;
          if (!entry.ready && uncertainIds.has(entry.id)) {
            entry.status = "blocked"; entry.reason = "preparation_interrupted";
          }
        }
      }
      await this.publish(next);
      await this.clearAdmission();
      await this.clearTemporarySnapshots();
      this.recoveryPins.clear();
      return this;
    } catch {
      this.markUnavailable(raw);
      throw new InboxError("inbox_storage_unavailable", 503);
    }
  }

  recover(mode) {
    if (!["reload", "reset"].includes(mode)) throw new InboxError("invalid_inbox_recovery", 400);
    return this.exclusive(async () => {
      if (!this.storageFailed) return { status: "ready", clients: [...this.clients] };
      try {
        await this.initialize();
        return { status: "ready", clients: [...this.clients] };
      } catch (error) {
        if (mode !== "reset" || !this.corruptStorage) throw error;
      }
      const archive = `messages.invalid-${crypto.randomUUID()}.json`;
      try {
        await this.fsPromises.rename(this.file, path.join(this.directory, archive));
        await this.syncDirectory();
        await this.initialize();
        return { status: "ready", clients: [...this.clients], archive };
      } catch {
        this.markUnavailable();
        throw new InboxError("inbox_storage_unavailable", 503);
      }
    });
  }

  async guardAdmission(id) {
    const name = `.admission-${id}`;
    this.admissionGuards.add(name);
    const handle = await this.fsPromises.open(path.join(this.directory, name), "wx", 0o600);
    try { await handle.sync(); }
    finally { await handle.close(); }
    await this.syncDirectory();
  }

  async clearAdmission() {
    if (!this.admissionGuards.size) return;
    for (const name of this.admissionGuards) {
      try { await this.fsPromises.unlink(path.join(this.directory, name)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      this.admissionGuards.delete(name);
    }
    await this.syncDirectory();
  }

  async clearTemporarySnapshots() {
    let removed = false;
    for (const name of await this.fsPromises.readdir(this.directory)) {
      if (!/^\.pending-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name)) continue;
      const file = path.join(this.directory, name);
      const info = await this.fsPromises.lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      await this.fsPromises.unlink(file); removed = true;
    }
    if (removed) await this.syncDirectory();
  }

  exclusive(callback) {
    const task = this.tail.then(callback);
    this.tail = task.catch(() => {});
    return task;
  }

  compactReceipt(entry) {
    const { id, receipt, clientId, sequence, completedAt } = entry;
    return { id, receipt, clientId, sequence, completedAt, status: "completed" };
  }

  prune(state) {
    const receipts = state.entries.filter((entry) => entry.status === "completed" &&
      entry.completedAt > this.now() - this.receiptRetentionMs).slice(-this.maxReceipts);
    const keep = new Set(receipts.map((entry) => entry.id));
    state.entries = state.entries.filter((entry) => entry.status !== "completed" || keep.has(entry.id))
      .map((entry) => entry.status === "completed" ? this.compactReceipt(entry) : entry);
  }

  async publish(next, admission = false) {
    if (this.storageFailed) throw new InboxError("inbox_storage_unavailable", 503);
    this.prune(next);
    const data = JSON.stringify(next);
    // Reserve room for bounded media metadata, watchdog fields and claim state.
    // A full inbox must still be able to prepare, hold and finish existing work.
    const headroom = admission ? next.entries.filter((entry) => entry.status !== "completed").length * 4096 : 0;
    if (Buffer.byteLength(data) + headroom > this.maxBytes) throw new InboxError("inbox_full", 507);
    if (data === this.serialized) return;
    const temporary = path.join(this.directory, `.pending-${crypto.randomUUID()}`);
    let handle;
    let publicationAttempted = false;
    try {
      handle = await this.fsPromises.open(temporary, "wx", 0o600);
      await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null;
      publicationAttempted = true;
      await this.fsPromises.rename(temporary, this.file);
      await this.syncDirectory();
      this.state = next;
      this.serialized = data;
    } catch {
      if (publicationAttempted) this.markUnavailable(data);
      throw new InboxError("inbox_storage_unavailable", 503);
    } finally {
      await handle?.close().catch(() => {});
      await this.fsPromises.unlink(temporary).catch(() => {});
    }
  }

  transaction(change, admission = false) {
    return this.exclusive(async () => {
      if (this.storageFailed) throw new InboxError("inbox_storage_unavailable", 503);
      // Payloads are immutable between revisions. Copy metadata only, so a
      // receipt update does not clone every queued attachment envelope.
      const next = { ...this.state, entries: this.state.entries.map((entry) => ({ ...entry })) };
      const result = await change(next);
      const guarded = admission && result !== null;
      if (guarded) {
        try { await this.guardAdmission(result); }
        catch {
          this.markUnavailable();
          throw new InboxError("inbox_storage_unavailable", 503);
        }
      }
      try { await this.publish(next, guarded); }
      catch (error) {
        if (guarded && !this.storageFailed) await this.clearAdmission().catch(() => this.markUnavailable());
        throw error;
      }
      if (guarded) {
        await this.clearAdmission().catch(() => {
          this.markUnavailable();
          this.logger.error?.("WhatsApp inbox admission guard could not be cleared; reload inbox storage after checking the app storage.");
        });
      }
      return result;
    });
  }

  async syncDirectory(directoryPath = this.directory) {
    if (process.platform === "win32") return;
    const directory = await this.fsPromises.open(directoryPath, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async enqueue(clientId, payload) {
    if (!this.enabled(clientId)) throw new InboxError("inbox_disabled", 400);
    if (!payload?.key?.id || typeof payload.key.id !== "string" ||
        typeof payload.key.remoteJid !== "string" || !payload.key.remoteJid ||
        payload.key.fromMe !== false || !payload.message || typeof payload.message !== "object" || Array.isArray(payload.message)) {
      throw new InboxError("invalid_inbox_message", 400);
    }
    let wire;
    try { wire = JSON.stringify(payload, wireValue); }
    catch { throw new InboxError("invalid_inbox_message", 400); }
    if (Buffer.byteLength(wire) > this.maxMessageBytes) throw new InboxError("inbox_message_too_large", 413);
    const id = messageId(clientId, payload);
    return this.transaction((state) => {
      if (state.entries.some((entry) => entry.id === id && (entry.status !== "completed" ||
          entry.completedAt > this.now() - this.receiptRetentionMs))) return null;
      if (state.entries.filter((entry) => entry.status !== "completed").length >= this.maxPending) {
        throw new InboxError("inbox_full", 507);
      }
      if (!Number.isSafeInteger(state.sequence + 1)) throw new InboxError("inbox_full", 507);
      state.entries.push({ id, receipt: crypto.randomBytes(32).toString("hex"),
        clientId, chatId: payload.key.remoteJid, messageId: payload.key.id,
        receivedAt: this.now(), sequence: ++state.sequence, status: "pending",
        ready: false, payload: JSON.parse(wire) });
      return id;
    }, true);
  }

  unready(clientId, limit = this.maxPending) {
    if (this.storageFailed || !this.enabled(clientId)) return [];
    return this.state.entries.filter((entry) => entry.status === "pending" && !entry.ready &&
      entry.clientId === clientId && (entry.nextAttemptAt || 0) <= this.now()).slice(0, limit)
      .map((entry) => ({ ...structuredClone(entry), payload: JSON.parse(JSON.stringify(entry.payload), mediaValue) }));
  }

  nextPreparationDelay(eligible) {
    if (this.storageFailed) return null;
    let delay = Infinity;
    for (const entry of this.state.entries) {
      if (entry.status === "pending" && !entry.ready && entry.nextAttemptAt !== undefined &&
          this.enabled(entry.clientId) && eligible(entry.clientId)) {
        delay = Math.min(delay, Math.max(0, entry.nextAttemptAt - this.now()));
      }
    }
    return Number.isFinite(delay) ? delay : null;
  }

  ready(id, media) {
    return this.transaction((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry || entry.status !== "pending" || entry.ready) return false;
      if (media?.status === "error" && TRANSIENT_MEDIA.has(media.error)) {
        entry.attempts = (entry.attempts || 0) + 1;
        if (entry.attempts < this.maxPreparationAttempts) {
          entry.nextAttemptAt = this.now() + this.preparationRetryMs * 2 ** (entry.attempts - 1);
          return false;
        }
      }
      if (media) entry.payload = { ...entry.payload, media: structuredClone(media) };
      entry.ready = true; entry.readyAt = this.now();
      delete entry.nextAttemptAt; delete entry.preparationAt;
      return true;
    });
  }

  isMediaPinned(id) {
    return this.recoveryPins.has(id) || this.state.entries.some((entry) => entry.status !== "completed" && entry.payload?.media?.id === id);
  }

  open(session) {
    if (!matches(SESSION, session)) throw new InboxError("invalid_inbox_session", 400);
    return this.transaction((state) => {
      if (state.session !== session) {
        for (const entry of state.entries) {
          if (entry.status === "processing") {
            entry.status = "interrupted"; entry.reason = "processing_interrupted";
          } else if (entry.status === "pending") {
            // The new HA consumer has not received this offer yet.
            delete entry.offeredAt;
          }
        }
        state.session = session;
      }
      return { status: "ready", clients: [...this.clients] };
    });
  }

  envelope(entry, session) {
    return { id: entry.id, receipt: entry.receipt, session,
      received_at: new Date(entry.receivedAt).toISOString() };
  }

  heads(entries) {
    const heads = new Map();
    for (const entry of entries) {
      if (this.enabled(entry.clientId) && ["pending", "processing"].includes(entry.status) &&
          (!heads.has(entry.clientId) || entry.status === "processing")) heads.set(entry.clientId, entry);
    }
    return heads;
  }

  attention(entry, session) {
    const disabled = !this.enabled(entry.clientId);
    if (entry.status === "completed" || (!disabled && !["blocked", "interrupted"].includes(entry.status))) return null;
    return { inbox: this.envelope(entry, session), clientId: entry.clientId,
      status: disabled ? "blocked" : entry.status, reason: disabled ? "account_disabled" : entry.reason };
  }

  async poll(session, renewMedia, clientReady = () => true, offer = true) {
    return this.exclusive(async () => {
      if (this.storageFailed) throw new InboxError("inbox_storage_unavailable", 503);
      if (!matches(SESSION, session) || this.state.session !== session) throw new InboxError("inbox_session_changed");
      // Most polls only read memory. Copy entries only for an actual state change.
      let next = this.state;
      if (next.entries.some((entry) => entry.status === "completed" &&
          entry.completedAt <= this.now() - this.receiptRetentionMs)) {
        next = { ...next, entries: next.entries.filter((entry) => entry.status !== "completed" ||
          entry.completedAt > this.now() - this.receiptRetentionMs) };
      }
      const replace = (entry, patch) => {
        if (next === this.state) next = { ...this.state, entries: [...this.state.entries] };
        const updated = { ...entry, ...patch };
        next.entries[next.entries.indexOf(entry)] = updated;
        return updated;
      };
      const active = () => next.entries.filter((entry) => entry.status !== "completed");
      const initialHeads = this.heads(active());
      const clearWait = (entry) => {
        const patch = {};
        for (const key of ["offeredAt", "preparationAt", "mediaWaitAt"]) {
          if (entry[key] !== undefined) patch[key] = undefined;
        }
        if (entry.offeredAt !== undefined) patch.receipt = crypto.randomBytes(32).toString("hex");
        return Object.keys(patch).length ? replace(entry, patch) : entry;
      };
      for (let entry of active()) {
        // Wall clocks can move backwards. Restart timeout windows from the new
        // time instead of leaving the queue stalled until the old date returns.
        for (const key of ["offeredAt", "startedAt", "preparationAt", "mediaWaitAt"]) {
          if (entry[key] > this.now()) entry = replace(entry, { [key]: this.now() });
        }
        if (entry.nextAttemptAt > this.now() + this.preparationRetryMs * 2 ** this.maxPreparationAttempts) {
          entry = replace(entry, { nextAttemptAt: this.now() + this.preparationRetryMs });
        }
        if (!this.enabled(entry.clientId)) continue;
        if (entry.status === "processing" && this.now() - (entry.startedAt ?? entry.receivedAt) >= this.processingTimeoutMs) {
          replace(entry, { status: "interrupted", reason: "processing_timeout" });
        } else if (entry.status === "pending") {
          // Queue age and disconnection time are not preparation failures. Only
          // an eligible account head receives a preparation or claim window.
          if (initialHeads.get(entry.clientId)?.id !== entry.id || !clientReady(entry.clientId)) {
            clearWait(entry); continue;
          }
          if (entry.offeredAt !== undefined && this.now() - entry.offeredAt >= this.claimTimeoutMs) {
            replace(entry, { status: "blocked", reason: "unclaimed" });
          } else if (!entry.ready && entry.preparationAt !== undefined &&
              this.now() - entry.preparationAt >= this.preparationTimeoutMs) {
            replace(entry, { status: "blocked", reason: "preparation_timeout" });
          }
        }
      }
      // A stalled account must not block a connected account. Held messages are
      // kept for explicit review, outside the automatic delivery path.
      const heads = this.heads(active());
      let selected;
      let waiting;
      let renewalError;
      for (let entry of heads.values()) {
        if (entry.status !== "pending" || !clientReady(entry.clientId)) { waiting ||= entry; continue; }
        if (!entry.ready) {
          if (entry.preparationAt === undefined) entry = replace(entry, { preparationAt: this.now() });
          waiting ||= entry; continue;
        }
        if (entry.payload.media?.status === "ready" && renewMedia) {
          let media;
          try { media = await renewMedia(entry.payload.media); }
          catch { media = { status: "error", error: "inbox_media_unavailable" }; }
          if (media?.status !== "ready") {
            if (media?.error !== "inbox_media_missing") {
              renewalError = "inbox_media_unavailable";
              if (entry.mediaWaitAt === undefined) entry = replace(entry, { mediaWaitAt: this.now() });
              if (this.now() - entry.mediaWaitAt >= this.preparationTimeoutMs) {
                replace(entry, { status: "blocked", reason: "preparation_timeout" });
                continue;
              }
              waiting ||= entry;
              continue;
            }
          }
          if (JSON.stringify(media) !== JSON.stringify(entry.payload.media)) {
            entry = replace(entry, { payload: { ...entry.payload, media } });
          }
          if (entry.mediaWaitAt !== undefined) entry = replace(entry, { mediaWaitAt: undefined });
        }
        if (offer && entry.offeredAt === undefined) entry = replace(entry, { offeredAt: this.now() });
        selected = entry; break;
      }
      if (next !== this.state) await this.publish(next);
      const counts = { pending: 0, processing: 0, interrupted: 0, blocked: 0 };
      const attention = [];
      for (const entry of active()) {
        const item = this.attention(entry, session);
        counts[item?.status || entry.status]++;
        if (item) attention.push(item);
      }
      const common = { counts, attention };
      if (selected) return { status: "pending", ...common,
        message: { ...structuredClone(selected.payload), clientId: selected.clientId, inbox: this.envelope(selected, session) } };
      if (waiting) return { status: waiting.status === "processing" ? "processing" : "preparing", ...common,
        inbox: this.envelope(waiting, session), ...(renewalError ? { error: renewalError } : {}) };
      if (attention.length) return { status: attention[0].status, ...common, inbox: attention[0].inbox };
      return { status: "empty", ...common };
    });
  }

  reference(state, reference, allowDisabled = false) {
    if (!reference || !matches(IDENTIFIER, reference.id) || !matches(IDENTIFIER, reference.receipt) ||
        !matches(SESSION, reference.session) || state.session !== reference.session) throw new InboxError("invalid_inbox_reference", 400);
    const entry = state.entries.find((item) => item.id === reference.id && item.receipt === reference.receipt);
    if (!entry || (!allowDisabled && !this.enabled(entry.clientId))) throw new InboxError("inbox_message_not_found", 404);
    return entry;
  }

  begin(reference) {
    return this.transaction((state) => {
      const entry = this.reference(state, reference);
      if (entry.status !== "pending" || !entry.ready) return { started: false, status: entry.status };
      const oldest = state.entries.find((item) => ["pending", "processing"].includes(item.status) && item.clientId === entry.clientId);
      if (oldest?.id !== entry.id || state.entries.some((item) => item.clientId === entry.clientId && item.status === "processing")) {
        throw new InboxError("inbox_message_out_of_order");
      }
      entry.status = "processing"; entry.session = reference.session; entry.startedAt = this.now();
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
      entry.status = "completed"; entry.completedAt = this.now(); delete entry.payload;
      return { status: "completed" };
    });
  }

  resolve(reference, resolution) {
    return this.transaction((state) => {
      const entry = this.reference(state, reference, resolution === "discard");
      if (resolution === "hold" && ["processing", "interrupted"].includes(entry.status)) {
        entry.status = "interrupted"; entry.reason = "workflow_failed";
        return { status: "interrupted" };
      }
      if (entry.status === "completed" && resolution === "discard") return { status: "completed" };
      if (!["pending", "interrupted", "blocked"].includes(entry.status) || !["retry", "discard"].includes(resolution)) {
        throw new InboxError("invalid_inbox_resolution", 400);
      }
      this.resolveEntry(entry, resolution);
      return { status: entry.status };
    });
  }

  resolveEntry(entry, resolution) {
    if (resolution === "discard") {
      entry.status = "completed"; entry.completedAt = this.now(); delete entry.payload;
    } else {
      entry.status = "pending"; entry.receipt = crypto.randomBytes(32).toString("hex");
      for (const key of ["session", "reason", "offeredAt", "startedAt", "preparationAt", "mediaWaitAt", "nextAttemptAt", "attempts"]) delete entry[key];
      if (entry.payload.media?.status === "error") {
        entry.payload = { ...entry.payload }; delete entry.payload.media; entry.ready = false;
      }
    }
  }

  resolveMany({ session, resolution, reason, clientId } = {}) {
    if (!["retry", "discard"].includes(resolution) || (!reason && !clientId) ||
        (reason !== undefined && (typeof reason !== "string" || !REASONS.has(reason))) ||
        (clientId !== undefined && (typeof clientId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(clientId)))) {
      throw new InboxError("invalid_inbox_filter", 400);
    }
    return this.transaction((state) => {
      if (!matches(SESSION, session) || state.session !== session) throw new InboxError("inbox_session_changed");
      let resolved = 0;
      for (const entry of state.entries) {
        const item = this.attention(entry, session);
        if (!item || (reason !== undefined && item.reason !== reason) || (clientId !== undefined && entry.clientId !== clientId)) continue;
        if (resolution === "retry" && !this.enabled(entry.clientId)) throw new InboxError("inbox_disabled", 400);
        this.resolveEntry(entry, resolution); resolved++;
      }
      return { status: "resolved", resolved, resolution };
    });
  }

  async close() { await this.tail; }
}

module.exports = { CAPABILITY, InboxError, MessageInbox };
