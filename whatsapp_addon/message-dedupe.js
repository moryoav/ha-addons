const crypto = require("crypto");

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;
const MEDIA_PAYLOAD_KEYS = new Set([
  "fileEncSha256",
  "fileLength",
  "fileSha256",
  "mediaKey",
  "mimetype",
]);
const VOLATILE_PAYLOAD_KEYS = new Set([
  "directPath",
  "jpegThumbnail",
  "mediaKeyTimestamp",
  "scanLengths",
  "scansSidecar",
  "thumbnailDirectPath",
  "thumbnailEncSha256",
  "thumbnailSha256",
  "url",
]);
const DIRECT_USER_JID_PLACEHOLDER = "[direct-user-jid]";
const UNSTABLE_JID_PAYLOAD_KEYS = new Set([
  "author",
  "mentionedJid",
  "participant",
  "senderLid",
  "senderPn",
]);

const hasMediaPayloadKey = (value) =>
  Object.keys(value).some((key) => MEDIA_PAYLOAD_KEYS.has(key));

const isDirectUserJid = (value) =>
  typeof value === "string" && /^[^@\s]+@(s\.whatsapp\.net|lid)$/.test(value);

const isUnstableJidPayloadKey = (key) =>
  typeof key === "string" &&
  (UNSTABLE_JID_PAYLOAD_KEYS.has(key) || key.toLowerCase().endsWith("jid"));

const normalizePayloadString = (value, key) => {
  if (isUnstableJidPayloadKey(key) && isDirectUserJid(value)) {
    return DIRECT_USER_JID_PLACEHOLDER;
  }

  return value;
};

const normalizeForHash = (value, seen = new WeakSet(), keyHint) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return normalizePayloadString(value, keyHint);
  if (typeof value !== "object") return value;

  if (Buffer.isBuffer(value)) {
    return { type: "Buffer", data: value.toString("base64") };
  }

  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor.name,
      data: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
        "base64"
      ),
    };
  }

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const normalized = value.map((item) => {
      const result = normalizeForHash(item, seen, keyHint);
      return result === undefined ? null : result;
    });
    seen.delete(value);
    return normalized;
  }

  const omitVolatilePayloadKeys = hasMediaPayloadKey(value);
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (omitVolatilePayloadKeys && VOLATILE_PAYLOAD_KEYS.has(key)) continue;

    const result = normalizeForHash(value[key], seen, key);
    if (result !== undefined) normalized[key] = result;
  }

  seen.delete(value);
  return normalized;
};

const stableStringify = (value) => JSON.stringify(normalizeForHash(value));

const hashMessagePayload = (payload) =>
  crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");

class MessageDedupe {
  #entries;
  #maxEntries;
  #now;
  #ttlMs;

  constructor({
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    now = () => Date.now(),
  } = {}) {
    this.#entries = new Map();
    this.#maxEntries = maxEntries;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  check(message, type) {
    const keyId = message?.key?.id;
    if (!keyId) {
      return {
        duplicate: false,
        collision: false,
        skipped: true,
        reason: "missing_key_id",
      };
    }

    const nowMs = this.#now();
    this.#prune(nowMs);

    const fromMe = !!message?.key?.fromMe;
    const payloadHash = hashMessagePayload(message?.message?.[type]);
    const baseKey = `${keyId}\x1f${fromMe ? "1" : "0"}\x1f${type}`;
    const metadata = {
      keyId,
      fromMe,
      type,
      remoteJid: message?.key?.remoteJid,
      messageTimestamp: message?.messageTimestamp,
      payloadHash,
      seenAt: new Date(nowMs).toISOString(),
      seenAtMs: nowMs,
    };

    const entry = this.#entries.get(baseKey);
    if (!entry) {
      this.#store(baseKey, {
        expiresAt: nowMs + this.#ttlMs,
        variants: new Map([[payloadHash, metadata]]),
      });

      return { duplicate: false, collision: false, ...metadata };
    }

    const existing = entry.variants.get(payloadHash);
    entry.expiresAt = nowMs + this.#ttlMs;
    this.#store(baseKey, entry);

    if (existing) {
      return {
        duplicate: true,
        collision: false,
        keyId,
        fromMe,
        type,
        payloadHash,
        firstRemoteJid: existing.remoteJid,
        duplicateRemoteJid: metadata.remoteJid,
        firstSeenAt: existing.seenAt,
        duplicateSeenAt: metadata.seenAt,
        ageMs: nowMs - existing.seenAtMs,
      };
    }

    const first = entry.variants.values().next().value;
    entry.variants.set(payloadHash, metadata);

    return {
      duplicate: false,
      collision: true,
      keyId,
      fromMe,
      type,
      firstRemoteJid: first.remoteJid,
      remoteJid: metadata.remoteJid,
      firstSeenAt: first.seenAt,
      collisionAt: metadata.seenAt,
      ageMs: nowMs - first.seenAtMs,
      firstPayloadHash: first.payloadHash,
      payloadHash,
    };
  }

  #prune(nowMs) {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= nowMs) {
        this.#entries.delete(key);
      }
    }
  }

  #store(key, entry) {
    if (this.#entries.has(key)) {
      this.#entries.delete(key);
    }

    this.#entries.set(key, entry);

    while (this.#entries.size > this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      this.#entries.delete(oldestKey);
    }
  }
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  DIRECT_USER_JID_PLACEHOLDER,
  MEDIA_PAYLOAD_KEYS,
  MessageDedupe,
  UNSTABLE_JID_PAYLOAD_KEYS,
  VOLATILE_PAYLOAD_KEYS,
  hashMessagePayload,
  stableStringify,
};
