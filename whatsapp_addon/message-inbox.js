const crypto = require("node:crypto");
const fs = require("node:fs/promises");
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
    maxBytes = 32 * 1024 * 1024, maxMessageBytes = 1024 * 1024, now = Date.now } = {}) {
    Object.assign(this, { directory, fsPromises, maxPending, maxBytes, maxMessageBytes, now });
    this.file = path.join(directory, "messages.json");
    this.state = { version: 1, pending: [], delivered: [] };
    this.tail = Promise.resolve();
    this.failed = false;
  }

  /** Load an intact snapshot without replacing unreadable or oversized state. */
  async start() {
    try {
      await this.fsPromises.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await this.fsPromises.lstat(this.directory)).isSymbolicLink()) throw new Error();
      await this.fsPromises.chmod(this.directory, 0o700);
      try {
        const stat = await this.fsPromises.lstat(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes) throw new Error();
        await this.fsPromises.chmod(this.file, 0o600);
        const saved = JSON.parse(await this.fsPromises.readFile(this.file, "utf8"));
        this.validate(saved);
        this.state = saved;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      for (const name of await this.fsPromises.readdir(this.directory)) {
        if (/^\.pending-[a-f0-9-]{36}$/.test(name)) {
          const file = path.join(this.directory, name);
          if ((await this.fsPromises.lstat(file)).isFile()) await this.fsPromises.unlink(file);
        }
      }
      await this.syncDirectory();
      await this.syncDirectory(path.dirname(this.directory));
      return this;
    } catch {
      this.failed = true;
      throw new Error("WhatsApp inbox storage could not be loaded; the original files are preserved.");
    }
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
        || !entry.payload.key.remoteJid || messageId(entry.clientId, entry.payload) !== entry.id
        || Buffer.byteLength(JSON.stringify(entry.payload)) > this.maxMessageBytes) throw new Error();
    }
    if (saved.delivered.some((entry) => !Number.isFinite(entry.at) || entry.at < 0)) throw new Error();
  }

  /** Persist a mutation before publishing it in memory; stop after any I/O failure. */
  update(change) {
    const task = this.tail.then(async () => {
      if (this.failed) throw new Error("WhatsApp inbox storage is unavailable.");
      const next = { version: 1, pending: [...this.state.pending],
        delivered: this.state.delivered.filter((entry) => entry.at > this.now() - 7 * 86400000) };
      if (!change(next)) return;
      next.delivered = next.delivered.slice(-1000);
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
      } catch {
        this.failed = true;
        throw new Error("WhatsApp inbox could not be saved; restart the app after checking storage.");
      } finally {
        await handle?.close().catch(() => {});
        await this.fsPromises.unlink(temporary).catch(() => {});
      }
    });
    this.tail = task.catch(() => {});
    return task;
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
    const entry = this.state.pending.find((item) => eligible(item.clientId));
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
