const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { RequestValidationError } = require("./validation");

const MEDIA_ROOT = "/media/whatsapp";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MB = 1024 * 1024;
const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

class MediaError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const parseMediaOptions = (options) => {
  const enabled =
    options.download_media === undefined ? false : options.download_media;
  if (typeof enabled !== "boolean") {
    throw new RequestValidationError("download_media must be a boolean.");
  }
  const integer = (name, fallback, maximum) => {
    const value = options[name] === undefined ? fallback : options[name];
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new RequestValidationError(
        `${name} must be an integer from 1 to ${maximum}.`,
      );
    }
    return value;
  };
  const maxFileBytes = integer("media_max_file_mb", 64, 1024) * MB;
  const maxStorageBytes = integer("media_max_storage_mb", 1024, 102400) * MB;
  if (maxStorageBytes < maxFileBytes) {
    throw new RequestValidationError(
      "media_max_storage_mb must be at least media_max_file_mb.",
    );
  }
  return {
    enabled,
    retentionMs: integer("media_retention_hours", 24, 720) * 3600000,
    maxFileBytes,
    maxStorageBytes,
  };
};

const describeMedia = (content) => {
  const mime =
    typeof content.mimetype === "string"
      ? content.mimetype.split(";")[0].trim().toLowerCase()
      : "";
  const mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    ? mime
    : "application/octet-stream";
  return {
    mime_type: mimeType,
    filename: `file.${EXTENSIONS[mimeType] || "bin"}`,
    // Original names are metadata only, never paths or HTTP headers.
    ...(typeof content.fileName === "string"
      ? {
          original_filename: content.fileName
            .replace(/[\x00-\x1f\x7f]/g, "")
            .slice(0, 255),
        }
      : {}),
  };
};

const expectedHash = (value) => {
  const result =
    typeof value === "string"
      ? Buffer.from(value, "base64")
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : undefined;
  if (!result || result.length !== 32) throw new MediaError("invalid_metadata");
  return result;
};

/** Owns only generated UUID directories; message/session data is never persisted. */
class MediaStore {
  constructor({
    root = MEDIA_ROOT,
    enabled = false,
    retentionMs = 86400000,
    maxFileBytes = 64 * MB,
    maxStorageBytes = 1024 * MB,
    maxFiles = 10000,
    concurrency = 2,
    maxPending = 32,
    timeoutMs = 60000,
    cleanupIntervalMs = 300000,
    now = Date.now,
    logger = console,
  } = {}) {
    Object.assign(this, {
      root: path.resolve(root),
      enabled,
      retentionMs,
      maxFileBytes,
      maxStorageBytes,
      maxFiles,
      concurrency,
      maxPending,
      timeoutMs,
      cleanupIntervalMs,
      now,
      logger,
    });
    this.usedBytes = 0;
    this.reservedBytes = 0;
    this.active = 0;
    this.pending = new Set();
    this.waiters = [];
    this.controllers = new Set();
    this.entries = new Map();
    this.lock = Promise.resolve();
    this.closed = false;
    this.available = false;
  }

  exclusive(callback) {
    const task = this.lock.then(callback);
    this.lock = task.catch(() => {});
    return task;
  }

  async start() {
    await this.exclusive(() => this.scan());
    this.timer = setInterval(() => {
      void this.cleanup().catch(() => {
        this.logger.warn?.(
          "WhatsApp media cleanup failed; retrying at the next interval.",
        );
      });
    }, this.cleanupIntervalMs);
    this.timer.unref?.();
    return this;
  }

  async scan() {
    try {
      await fs.promises.mkdir(this.root, { recursive: true });
      if ((await fs.promises.lstat(this.root)).isSymbolicLink())
        throw new Error();
      for (const item of await fs.promises.readdir(this.root, {
        withFileTypes: true,
      })) {
        if (!item.isDirectory() || item.isSymbolicLink()) continue;
        if (
          item.name.startsWith(".partial-") &&
          UUID.test(item.name.slice(9))
        ) {
          await this.removeDirectory(item.name);
          continue;
        }
        if (!UUID.test(item.name)) continue;
        try {
          const directory = path.join(this.root, item.name);
          const metadata = JSON.parse(
            await fs.promises.readFile(
              path.join(directory, "metadata.json"),
              "utf8",
            ),
          );
          if (
            !Number.isFinite(Date.parse(metadata.expires_at)) ||
            !/^file\.[a-z0-9]+$/.test(metadata.filename)
          )
            throw new Error();
          const stat = await fs.promises.lstat(
            path.join(directory, metadata.filename),
          );
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
          this.entries.set(item.name, {
            size: stat.size,
            expires: Date.parse(metadata.expires_at),
          });
          this.usedBytes += stat.size;
        } catch {
          await this.removeDirectory(item.name);
        }
      }
      this.available = true;
      await this.prune();
    } catch {
      this.available = false;
      this.logger.warn?.(
        "WhatsApp media storage is unavailable. Check the shared /media mount and free space.",
      );
    }
  }

  async removeDirectory(name) {
    // Never remove a caller-provided path or follow a directory symlink.
    if (
      !UUID.test(name) &&
      !(name.startsWith(".partial-") && UUID.test(name.slice(9)))
    ) {
      throw new MediaError("storage_error");
    }
    await fs.promises.rm(path.join(this.root, name), {
      recursive: true,
      force: true,
    });
  }

  async prune() {
    for (const [id, entry] of this.entries) {
      if (entry.expires > this.now()) continue;
      await this.removeDirectory(id);
      this.entries.delete(id);
      this.usedBytes -= entry.size;
    }
  }

  cleanup() {
    return this.exclusive(async () => {
      if (!this.available) {
        this.entries.clear();
        this.usedBytes = 0;
        await this.scan();
      } else {
        await this.prune();
      }
    });
  }

  /** A bounded queue, including wait time in the download deadline. */
  enrich(message, client) {
    if (!this.enabled) return Promise.resolve(undefined);
    let content;
    try {
      content = client.getMediaContent(message);
    } catch {
      return Promise.resolve({ status: "error", error: "invalid_metadata" });
    }
    if (!content) return Promise.resolve(undefined);
    if (this.closed || this.pending.size >= this.maxPending) {
      return Promise.resolve({
        status: "error",
        error: this.closed ? "stopped" : "queue_full",
      });
    }
    const task = this.run(message, content, client).catch((error) => ({
      status: "error",
      error: error instanceof MediaError ? error.code : "download_failed",
    }));
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
    return task;
  }

  async run(message, content, client) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(new MediaError("timeout")),
      this.timeoutMs,
    );
    const { signal } = controller;
    let acquired = false;
    try {
      if (this.active >= this.concurrency) {
        await new Promise((resolve, reject) => {
          const waiter = () => {
            signal.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            this.waiters = this.waiters.filter((entry) => entry !== waiter);
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
          this.waiters.push(waiter);
        });
      } else {
        this.active += 1;
      }
      acquired = true;
      signal.throwIfAborted();
      return await this.save(message, content, client, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      if (acquired) {
        const next = this.waiters.shift();
        if (next) next();
        else this.active -= 1;
      }
    }
  }

  async save(message, content, client, signal) {
    const hash = expectedHash(content.fileSha256);
    const details = describeMedia(content);
    const id = crypto.randomUUID();
    const partialName = `.partial-${id}`;
    const partial = path.join(this.root, partialName);
    const destination = path.join(this.root, id);
    let reserved = false;
    let published = false;
    let created = false;
    try {
      await this.exclusive(async () => {
        if (!this.available) throw new MediaError("storage_unavailable");
        await this.prune();
        signal.throwIfAborted();
        // Reserve the maximum before starting, so concurrent streams cannot exceed the quota.
        if (
          this.usedBytes + this.reservedBytes + this.maxFileBytes >
            this.maxStorageBytes ||
          this.entries.size + this.reservedBytes / this.maxFileBytes >=
            this.maxFiles
        ) {
          throw new MediaError("storage_full");
        }
        this.reservedBytes += this.maxFileBytes;
        reserved = true;
      });
      await fs.promises.mkdir(partial);
      created = true;
      const hasher = crypto.createHash("sha256");
      let size = 0;
      const maxBytes = this.maxFileBytes;
      const verify = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > maxBytes)
            return callback(new MediaError("file_too_large"));
          hasher.update(chunk);
          callback(null, chunk);
        },
      });
      const stream = await client.downloadMedia(message, {
        signal,
        timeoutMs: this.timeoutMs,
      });
      await pipeline(
        stream,
        verify,
        fs.createWriteStream(path.join(partial, details.filename), {
          flags: "wx",
        }),
        { signal },
      );
      if (!crypto.timingSafeEqual(hash, hasher.digest()))
        throw new MediaError("checksum_mismatch");
      signal.throwIfAborted();
      const metadata = {
        ...details,
        size,
        expires_at: new Date(this.now() + this.retentionMs).toISOString(),
      };
      await fs.promises.writeFile(
        path.join(partial, "metadata.json"),
        JSON.stringify(metadata),
        { flag: "wx" },
      );
      await this.exclusive(async () => {
        signal.throwIfAborted();
        await fs.promises.rename(partial, destination);
        published = true;
        this.entries.set(id, {
          size,
          expires: Date.parse(metadata.expires_at),
        });
        this.usedBytes += size;
      });
      return {
        status: "ready",
        id,
        ...metadata,
        local_path: path.join(destination, details.filename),
        url: `/api/whatsapp/media/${id}`,
      };
    } catch (error) {
      if (error instanceof MediaError || signal.aborted) throw error;
      if (error?.code === "ENOSPC") throw new MediaError("storage_full");
      throw new MediaError("download_failed");
    } finally {
      if (created && !published) {
        await this.removeDirectory(partialName).catch(() => {
          this.logger.warn?.(
            "WhatsApp partial media cleanup failed; restart to retry cleanup.",
          );
        });
      }
      if (reserved)
        await this.exclusive(() => {
          this.reservedBytes -= this.maxFileBytes;
        });
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.controllers)
      controller.abort(new MediaError("stopped"));
    await Promise.allSettled([...this.pending]);
    await this.lock;
  }
}

module.exports = { MEDIA_ROOT, MediaStore, parseMediaOptions };
