"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RECORDING_ROOT = "/media/whatsapp/call-recordings";
const FILENAME = /^\d{8}T\d{6}Z-[a-f0-9]{32}\.wav$/;
const DAY = 86400000;

class RecordingStore {
  constructor({ root = RECORDING_ROOT, enabled = false, retentionDays = 30, now = Date.now, logger = {} } = {}) {
    Object.assign(this, { root:path.resolve(root), enabled, retentionDays, now, logger });
    this.available = false;
    this.lastError = null;
    this.active = new Set();
    this.ready = Promise.resolve();
  }

  start() {
    this.timer = setInterval(() => { void this.cleanup().catch(() => this.failed()); }, 3600000);
    this.timer.unref?.();
    this.ready = (async () => {
      if (this.enabled) await fs.promises.mkdir(this.root, { recursive:true, mode:0o700 });
      this.available = await this.safeRoot();
      if (this.available) await this.cleanup();
    })().catch(() => { this.available = false; this.failed(); });
    return this.ready;
  }

  async safeRoot() {
    try {
      const stat = await fs.promises.lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(this.root) !== this.root) throw Error();
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw Error("Recording storage is unavailable.");
    }
  }

  status() {
    return { enabled:this.enabled, available:this.available, retention_days:this.retentionDays, last_error:this.lastError };
  }

  begin() {
    if (!this.enabled) return null;
    if (!this.available) { this.failed(); return null; }
    this.lastError = null;
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const filename = stamp + "-" + crypto.randomUUID().replace(/-/g, "") + ".wav";
    this.active.add(filename);
    return filename;
  }

  release(filename) { this.active.delete(filename); }

  async completed(filename, answered) {
    if (!filename || !answered) return;
    try {
      const file = await this.open(filename);
      if (file) await file.handle.close();
      else this.failed();
    } catch { this.failed(); }
  }

  failed() {
    if (!this.lastError) this.logger.warn?.("Call recording is unavailable; voice calls continue normally.");
    this.lastError = "The recording could not be saved. Voice calls continue normally.";
  }

  async cleanup() {
    if (!await this.safeRoot()) return;
    const cutoff = this.now() - this.retentionDays * DAY;
    for (const entry of await fs.promises.readdir(this.root, { withFileTypes:true })) {
      const partial = entry.name.endsWith(".part");
      const filename = partial ? entry.name.slice(0, -5) : entry.name;
      if (!FILENAME.test(filename) || !entry.isFile() || entry.isSymbolicLink() || this.active.has(filename)) continue;
      const target = path.join(this.root, entry.name);
      try {
        const stat = await fs.promises.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const expiry = partial ? this.now() - Math.min(this.retentionDays * DAY, DAY) : cutoff;
        if (stat.mtimeMs <= expiry) await fs.promises.unlink(target);
      } catch (error) { if (error.code !== "ENOENT") throw Error("Recording cleanup failed."); }
    }
  }

  async open(filename) {
    if (!FILENAME.test(filename)) return null;
    await this.ready;
    if (!await this.safeRoot()) return null;
    let handle;
    try {
      const target = path.join(this.root, filename);
      if ((await fs.promises.lstat(target)).isSymbolicLink()) return null;
      handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 46 || stat.size > 64 * 1024 * 1024 || stat.mtimeMs + this.retentionDays * DAY <= this.now()) throw Error();
      const header = Buffer.alloc(44);
      const { bytesRead } = await handle.read(header, 0, 44, 0);
      if (bytesRead !== 44 || header.toString("ascii",0,4) !== "RIFF" || header.toString("ascii",8,16) !== "WAVEfmt " ||
        header.readUInt32LE(16) !== 16 || header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 1 ||
        header.readUInt32LE(24) !== 16000 || header.readUInt32LE(28) !== 32000 || header.readUInt16LE(32) !== 2 ||
        header.readUInt16LE(34) !== 16 || header.toString("ascii",36,40) !== "data" ||
        header.readUInt32LE(40) + 44 !== stat.size || header.readUInt32LE(4) + 8 !== stat.size || stat.size % 2 !== 0) throw Error();
      const stamp = filename.slice(0,16);
      const created = `${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(9,11)}:${stamp.slice(11,13)}:${stamp.slice(13,15)}Z`;
      return { handle, metadata:{ filename, created_at:created, expires_at:new Date(stat.mtimeMs + this.retentionDays * DAY).toISOString(),
        duration_seconds:Math.round((stat.size - 44) / 32) / 1000, size_bytes:stat.size } };
    } catch {
      await handle?.close();
      return null;
    }
  }

  async list() {
    await this.ready;
    if (!await this.safeRoot()) return [];
    const names = (await fs.promises.readdir(this.root)).filter(name => FILENAME.test(name)).sort().reverse();
    const recordings = [];
    for (const filename of names) {
      const file = await this.open(filename);
      if (file) {
        recordings.push(file.metadata);
        await file.handle.close();
      }
      if (recordings.length >= 100) break;
    }
    return recordings;
  }

  close() { clearInterval(this.timer); }
}

module.exports = { RecordingStore, RECORDING_ROOT, FILENAME };
