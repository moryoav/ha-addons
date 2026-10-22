const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { hashMessagePayload } = require("./message-dedupe");

/** Identify a message without storing chat identifiers in filenames or logs. */
const messageId = (clientId, message) => crypto.createHash("sha256")
  .update(JSON.stringify([clientId, message?.key?.id, message?.type,
    hashMessagePayload(message?.message?.[message?.type] ?? message?.message)])).digest("hex");

/** Preserve Baileys binary media keys and protobuf integers in private JSON. */
const encode = (_, value) => typeof value === "bigint" ? value.toString()
  : value instanceof Uint8Array ? { type: "Buffer", data: [...value] } : value;

/** Restore binary keys before passing a queued message to the media downloader. */
const decode = (_, value) => value?.type === "Buffer" && Array.isArray(value.data)
  && value.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ? Buffer.from(value.data) : value;

/** A bounded, private FIFO; remove messages only after Home Assistant accepts them. */
class MessageInbox {
  /** Configure storage limits; all mutations share one serialized writer. */
  constructor({ directory, fsPromises = fs, maxPending = 1000,
    maxBytes = 32 * 1024 * 1024, maxMessageBytes = 1024 * 1024, now = Date.now, logger = {} } = {}) {
    Object.assign(this, { directory, fsPromises, maxPending, maxBytes, maxMessageBytes, now, logger });
    this.file = path.join(directory, "messages.json");
    this.state = { version: 1, pending: [], delivered: [] };
    this.tail = Promise.resolve();
    this.failed = false;
  }

  /** Serialize initial loading and automatic recovery with all pending writes. */
  start() {
    const task = this.tail.then(() => this.load());
    this.tail = task.catch(() => {});
    return task;
  }

  /** Reload uncertain writes; archive invalid data before salvaging valid entries. */
  async load() {
    try {
      await this.fsPromises.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await this.fsPromises.lstat(this.directory)).isSymbolicLink()) throw new Error();
      await this.fsPromises.chmod(this.directory, 0o700);
      let saved = { version: 1, pending: [], delivered: [] };
      try {
        const stat = await this.fsPromises.lstat(this.file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        await this.fsPromises.chmod(this.file, 0o600);
        let invalid = stat.size > this.maxBytes;
        if (!invalid) {
          const raw = await this.fsPromises.readFile(this.file, "utf8");
          try {
            const parsed = JSON.parse(raw);
            saved = this.salvage(parsed);
            invalid = JSON.stringify(saved) !== JSON.stringify(parsed);
          } catch { invalid = true; }
        }
        if (invalid) {
          const archive = path.join(this.directory, `messages.invalid-${crypto.randomUUID()}.json`);
          await this.fsPromises.copyFile(this.file, archive, constants.COPYFILE_EXCL);
          await this.fsPromises.chmod(archive, 0o600);
          const handle = await this.fsPromises.open(archive, "r+");
          try { await handle.sync(); } finally { await handle.close(); }
          await this.syncDirectory();
          await this.persist(saved);
          this.logger.warn?.("Invalid WhatsApp inbox data was archived privately; valid messages were retained.");
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      for (const name of await this.fsPromises.readdir(this.directory)) {
        if (/^\.pending-[a-f0-9-]{36}$/.test(name)) {
          const file = path.join(this.directory, name);
          if ((await this.fsPromises.lstat(file)).isFile()) await this.fsPromises.unlink(file);
        }
      }
      await this.syncDirectory();
      await this.syncDirectory(path.dirname(this.directory));
      this.state = saved;
      this.failed = false;
      return this;
    } catch {
      this.failed = true;
      throw new Error("WhatsApp inbox storage could not be loaded; the original files are preserved.");
    }
  }

  /** Keep valid rows while preserving the entire original file in an archive. */
  salvage(saved) {
    try { this.validate(saved); return saved; } catch { /* Inspect individual rows. */ }
    const clean = { version: 1, pending: [], delivered: [] };
    if (saved?.version !== 1 || !Array.isArray(saved.pending) || !Array.isArray(saved.delivered)) return clean;
    const ids = new Set();
    for (const kind of ["pending", "delivered"]) {
      for (const entry of saved[kind]) {
        if (clean[kind].length >= (kind === "pending" ? this.maxPending : 1000)) break;
        try {
          this.validate({ version: 1, pending: [], delivered: [], [kind]: [entry] });
          if (ids.has(entry.id)) continue;
          ids.add(entry.id); clean[kind].push(entry);
        } catch { /* The archived original retains this invalid row. */ }
      }
    }
    return clean;
  }

  /** Reject malformed entries rather than silently dropping private messages. */
  validate(saved) {
    if (!saved || saved.version !== 1 || !Array.isArray(saved.pending) || !Array.isArray(saved.delivered)
      || saved.pending.length > this.maxPending || saved.delivered.length > 1000) throw new Error();
    const ids = new Set();
    for (const entry of [...saved.pending, ...saved.delivered]) {
      if (!entry || typeof entry.id !== "string" || !/^[a-f0-9]{64}$/.test(entry.id) || ids.has(entry.id)) throw new Error();
      ids.add(entry.id);
    }
    for (const entry of saved.pending) {
      if (typeof entry.clientId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.clientId) || !entry.payload?.message
        || typeof entry.payload.message !== "object" || Array.isArray(entry.payload.message)
        || entry.payload.key?.fromMe !== false || typeof entry.payload.key.id !== "string"
        || !entry.payload.key.id || typeof entry.payload.key.remoteJid !== "string"
        || !entry.payload.key.remoteJid
        || Buffer.byteLength(JSON.stringify(entry.payload)) > this.maxMessageBytes) throw new Error();
    }
    if (saved.delivered.some((entry) => !Number.isFinite(entry.at) || entry.at < 0)) throw new Error();
  }

  /** Retry a failed write once after reloading disk, never from stale memory. */
  update(change) {
    const task = this.tail.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.failed) await this.load();
        const next = { version: 1, pending: [...this.state.pending],
          delivered: this.state.delivered.filter((entry) => entry.at > this.now() - 7 * 86400000) };
        if (!change(next)) return;
        next.delivered = next.delivered.slice(-1000);
        try { await this.persist(next); return; }
        catch (error) { if (!this.failed || attempt === 1) throw error; }
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }

  /** Publish an atomic snapshot only after its file and directory are durable. */
  async persist(next) {
    const data = JSON.stringify(next);
    if (Buffer.byteLength(data) > this.maxBytes) throw new Error("WhatsApp inbox is full.");
    const temporary = path.join(this.directory, `.pending-${crypto.randomUUID()}`);
    let handle;
    try {
      handle = await this.fsPromises.open(temporary, "wx", 0o600);
      await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null;
      await this.fsPromises.rename(temporary, this.file);
      await this.syncDirectory();
      this.state = next;
      this.failed = false;
    } catch {
      this.failed = true;
      throw new Error("WhatsApp inbox could not be saved; delivery will retry after reloading storage.");
    } finally {
      await handle?.close().catch(() => {});
      await this.fsPromises.unlink(temporary).catch(() => {});
    }
  }

  /** Store the original message before media work or HTTP delivery can begin. */
  enqueue(clientId, payload) {
    const wire = JSON.stringify(payload, encode);
    if (Buffer.byteLength(wire) > this.maxMessageBytes) throw new Error("WhatsApp inbox message is too large.");
    const stored = JSON.parse(wire);
    const entry = { id: messageId(clientId, stored), clientId, payload: stored };
    this.validate({ version: 1, pending: [entry], delivered: [] });
    return this.update((next) => {
      if ([...next.pending, ...next.delivered].some((item) => item.id === entry.id)) return false;
      if (next.pending.length >= this.maxPending) throw new Error("WhatsApp inbox is full.");
      next.pending.push(entry);
      return true;
    });
  }

  /** Return the oldest eligible message without allowing callers to mutate storage. */
  peek(eligible) {
    if (this.failed) return undefined;
    const accounts = new Set();
    const entry = this.state.pending.find((item) => {
      if (accounts.has(item.clientId)) return false;
      accounts.add(item.clientId);
      return eligible(item.clientId, item.payload);
    });
    return entry ? JSON.parse(JSON.stringify(entry), decode) : undefined;
  }

  /** Erase accepted payloads and retain only bounded duplicate receipts. */
  delivered(id) {
    return this.update((next) => {
      if (!next.pending.some((entry) => entry.id === id)) return false;
      next.pending = next.pending.filter((entry) => entry.id !== id);
      next.delivered.push({ id, at: this.now() });
      return true;
    });
  }

  /** Flush directory entries as well as file content on the Linux app host. */
  async syncDirectory(directory = this.directory) {
    if (process.platform === "win32") return;
    const handle = await this.fsPromises.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  /** Wait for outstanding writes during orderly app shutdown. */
  async close() { await this.tail; }
}

module.exports = { MessageInbox };
