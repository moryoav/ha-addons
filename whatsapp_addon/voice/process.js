"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

class JsonProcess extends EventEmitter {
  constructor(command, args, { env = {}, spawnFn = spawn, timeoutMs = 15000 } = {}) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.tail = Promise.resolve();
    this.queuedBytes = 0;
    this.timeoutMs = timeoutMs;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A startup failure may precede the first request.
    this.ready.catch(() => {});
    this.child = spawnFn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.readyTimer = setTimeout(() => this.fail(), 15000);
    let buffer = Buffer.alloc(0);
    this.child.stdout.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) return this.fail();
      let at;
      while ((at = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, at);
        buffer = buffer.subarray(at + 1);
        let event;
        try { event = JSON.parse(line.toString("utf8")); } catch { return this.fail(); }
        if (event.type === "ready" && event.protocol === 1) {
          clearTimeout(this.readyTimer);
          this.resolveReady();
        } else if (event.type === "response") {
          const pending = this.pending.get(event.id);
          if (!pending) continue;
          this.pending.delete(event.id);
          clearTimeout(pending.timer);
          event.ok ? pending.resolve(event.result) : pending.reject(new Error("worker_operation_failed"));
        } else this.emit("event", event);
      }
    });
    // Raw dependency errors can contain keys, identifiers, or transcript data.
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
  }

  fail() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    this.rejectReady(new Error("voice_worker_unavailable"));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("voice_worker_unavailable"));
    }
    this.pending.clear();
    this.child.kill();
    this.emit("failure");
  }

  send(value) {
    if (this.closed) return Promise.reject(new Error("voice_worker_unavailable"));
    const line = JSON.stringify(value) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > 1024 * 1024 || this.queuedBytes + bytes > 1024 * 1024) {
      this.fail();
      return Promise.reject(new Error("voice_backpressure"));
    }
    this.queuedBytes += bytes;
    this.tail = this.tail.then(async () => {
      if (this.closed) throw new Error("voice_worker_unavailable");
      if (!this.child.stdin.write(line)) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 3000);
        try { await once(this.child.stdin, "drain", { signal: abort.signal }); }
        finally { clearTimeout(timer); }
      }
    }).finally(() => { this.queuedBytes -= bytes; });
    this.tail.catch(() => this.fail());
    return this.tail;
  }

  async request(action, arguments_ = {}, timeoutMs = this.timeoutMs) {
    await this.ready;
    if (this.closed || this.pending.size >= 64) throw new Error("voice_worker_unavailable");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("voice_worker_timeout"));
        this.fail();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ ...arguments_, action, id }).catch(() => {});
    });
  }

  close() { this.fail(); }
}

function childEnvironment(source = process.env, includeHomeAssistant = false) {
  const names = ["PATH", "SYSTEMROOT", "WINDIR", "LANG", "LD_LIBRARY_PATH", "PYTHONPATH"];
  if (includeHomeAssistant) names.push("SUPERVISOR_TOKEN", "HA_TOKEN", "HA_API_URL");
  return Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}

module.exports = { JsonProcess, childEnvironment };
