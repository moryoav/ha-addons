// Store protobuf bytes, not references to messages that event consumers mutate.
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const CIPHERTEXT_STUB = 2;

const cacheKey = (key) => {
  if (
    key?.fromMe !== true ||
    typeof key.remoteJid !== "string" ||
    !key.remoteJid ||
    key.remoteJid.length > 256 ||
    typeof key.id !== "string" ||
    !key.id ||
    key.id.length > 256
  ) {
    return undefined;
  }
  // Never use an ID-only fallback or guess a phone-number/LID mapping.
  return JSON.stringify([key.remoteJid, key.id]);
};

class MessageRetryCache {
  #entries = new Map();
  #bytes = 0;
  #codec;
  #now;
  #ttlMs;
  #maxEntries;
  #maxBytes;
  #maxMessageBytes;
  #timer;
  #closed = false;

  constructor({
    codec,
    now = Date.now,
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  }) {
    if (
      typeof codec?.encode !== "function" ||
      typeof codec?.decode !== "function"
    ) {
      throw new TypeError("A protobuf message codec is required.");
    }
    for (const limit of [ttlMs, maxEntries, maxBytes, maxMessageBytes]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new TypeError("Retry cache limits must be positive integers.");
      }
    }
    this.#codec = codec;
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
    this.#maxMessageBytes = Math.min(maxMessageBytes, maxBytes);
    this.#timer = setInterval(() => this.#prune(), Math.min(ttlMs, 60_000));
    this.#timer.unref?.();
  }

  #delete(key) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#bytes -= entry.bytes;
    this.#entries.delete(key);
  }

  #prune() {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#delete(key);
    }
  }

  put(message) {
    if (this.#closed) return { stored: false, reason: "closed" };
    const key = cacheKey(message?.key);
    if (
      !key ||
      !message?.message ||
      message.messageStubType === CIPHERTEXT_STUB
    ) {
      return { stored: false, reason: "not_retryable" };
    }
    this.#prune();
    // Replays must not replace the original content or extend its lifetime.
    if (this.#entries.has(key)) {
      return { stored: false, reason: "already_cached" };
    }
    try {
      const writer = this.#codec.encode(message.message);
      if (!writer.len) return { stored: false, reason: "empty" };
      if (writer.len > this.#maxMessageBytes) {
        return { stored: false, reason: "too_large" };
      }
      const bytes = writer.len + Buffer.byteLength(key, "utf8");
      if (bytes > this.#maxBytes) return { stored: false, reason: "too_large" };
      const encoded = Buffer.from(writer.finish());
      let evicted = 0;
      while (
        this.#entries.size >= this.#maxEntries ||
        this.#bytes + bytes > this.#maxBytes
      ) {
        this.#delete(this.#entries.keys().next().value);
        evicted += 1;
      }
      this.#entries.set(key, {
        encoded,
        bytes,
        expiresAt: this.#now() + this.#ttlMs,
      });
      this.#bytes += bytes;
      return { stored: true, bytes, evicted };
    } catch {
      // Cache failures must not interrupt normal sends or message delivery.
      return { stored: false, reason: "encode_failed" };
    }
  }

  get(key) {
    this.#prune();
    const entryKey = cacheKey(key);
    const entry = this.#entries.get(entryKey);
    if (!entry) return undefined;
    try {
      // Decoded byte fields may share the input buffer. Give each caller a copy.
      return this.#codec.decode(Buffer.from(entry.encoded));
    } catch {
      this.#delete(entryKey);
      return undefined;
    }
  }

  get stats() {
    this.#prune();
    return { entries: this.#entries.size, bytes: this.#bytes };
  }

  close() {
    clearInterval(this.#timer);
    this.#closed = true;
    this.#entries.clear();
    this.#bytes = 0;
  }
}

module.exports = { MessageRetryCache };
