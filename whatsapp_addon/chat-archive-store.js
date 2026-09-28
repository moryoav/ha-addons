const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_ENTRIES = 50_000;
const MAX_BYTES = 8 * 1024 * 1024;
const ownerId = (id) => typeof id === "string" ? id.replace(/:\d+@/, "@") : null;
const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 128;

// Only chat identifiers and explicit archive flags are retained, per session.
// Message delivery reads the Map synchronously; disk writes are coalesced.
class ChatArchiveStore {
  #file;
  #entries = new Map();
  #owner = null;
  #loaded = false;
  #dirty = false;
  #timer;
  #writing = Promise.resolve();
  #warn;
  #maxEntries;

  constructor({ directory, onError = () => {}, maxEntries = MAX_ENTRIES }) {
    this.#file = path.join(directory, "chat-archive-cache.json");
    this.#warn = onError;
    this.#maxEntries = maxEntries;
  }

  async load(account) {
    if (this.#loaded) {
      this.setOwner(account);
      return;
    }
    this.#loaded = true;
    this.#owner = ownerId(account);
    if (!this.#owner) return;
    try {
      const info = await fs.stat(this.#file);
      if (info.size > MAX_BYTES) throw new Error("oversized cache");
      const saved = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (saved.version !== 1 || saved.owner !== this.#owner || !Array.isArray(saved.chats)) return;
      for (const entry of saved.chats.slice(-this.#maxEntries)) {
        if (Array.isArray(entry) && validId(entry[0]) && typeof entry[1] === "boolean") {
          this.#entries.set(entry[0], entry[1]);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.#warn();
    }
  }

  setOwner(account) {
    const owner = ownerId(account);
    if (owner === this.#owner) return;
    this.#entries.clear();
    this.#owner = owner;
    this.#changed();
  }

  get(id) {
    return this.#entries.get(id) ?? null;
  }

  update(chats) {
    if (!Array.isArray(chats)) return;
    for (const chat of chats) {
      // Missing flags in partial updates must not turn archived chats false.
      if (!validId(chat?.id) || typeof chat.archived !== "boolean" || chat.conditional) continue;
      if (this.#entries.get(chat.id) === chat.archived) continue;
      this.#entries.delete(chat.id);
      this.#entries.set(chat.id, chat.archived);
      if (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value);
      this.#changed();
    }
  }

  delete(ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (this.#entries.delete(id)) this.#changed();
    }
  }

  clear() {
    this.#entries.clear();
    this.#changed();
  }

  #changed() {
    this.#dirty = true;
    if (this.#timer || !this.#owner) return;
    this.#timer = setTimeout(() => { void this.flush(); }, 250);
    this.#timer.unref?.();
  }

  async flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#dirty && this.#owner) {
      this.#dirty = false;
      const snapshot = JSON.stringify({ version: 1, owner: this.#owner, chats: [...this.#entries] });
      this.#writing = this.#writing.then(async () => {
        try {
          // The auth session already owns this directory. Never recreate it
          // after logout/reset, which could resurrect a deleted session.
          await fs.writeFile(`${this.#file}.tmp`, snapshot, { mode: 0o600 });
          await fs.rename(`${this.#file}.tmp`, this.#file);
        } catch {
          this.#dirty = true;
          this.#warn();
        }
      });
    }
    await this.#writing;
  }
}

module.exports = { ChatArchiveStore };
