const fs = require("node:fs/promises");
const path = require("node:path");

const COLLECTION = "critical_unblock_low";
const MAX_ENTRIES = 20_000;
const MAX_BYTES = 16 * 1024 * 1024;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 8_000;
/** Normalize a supported personal WhatsApp identifier without inferring aliases. */
const normalizeId = (value) => {
  if (typeof value !== "string") return null;
  const id = value.replace(/:\d+@/, "@");
  return /^(?:[1-9]\d{4,14}@s\.whatsapp\.net|[1-9]\d{4,30}@lid)$/.test(id) ? id : null;
};
/** Keep a bounded display name while preserving its language and spelling. */
const cleanName = (value) => typeof value === "string"
  ? value.replace(/[\r\n]+/g, " ").trim().slice(0, 256) || null : null;

/**
 * Read and authenticate current address-book metadata within a shared time budget.
 * Auth versions, message history, and unrelated sync actions are never changed
 * or replayed. Incomplete or unauthenticated collections are rejected.
 */
async function fetchContactNames(socket, baileys, keys) {
  const getKey = async (id) => (await keys.get("app-state-sync-key", [id]))[id];
  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  const remaining = () => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error("Contact metadata timed out");
    return timeout;
  };
  let state = baileys.newLTHashState();
  const records = new Map();
  for (let page = 0; page < 5; page += 1) {
    const response = await socket.query({
      tag: "iq",
      attrs: { to: "s.whatsapp.net", xmlns: "w:sync:app:state", type: "set" },
      content: [{ tag: "sync", attrs: {}, content: [{ tag: "collection", attrs: {
        name: COLLECTION, version: String(state.version),
        return_snapshot: String(state.version === 0),
      } }] }],
    }, remaining());
    const decoded = await baileys.extractSyncdPatches(response, { timeout: remaining() });
    const collection = decoded[COLLECTION];
    if (!collection) throw new Error("Contact metadata unavailable");
    const mutations = {};
    if (collection.snapshot) {
      const snapshot = await baileys.decodeSyncdSnapshot(COLLECTION, collection.snapshot, getKey, undefined, true);
      state = snapshot.state;
      Object.assign(mutations, snapshot.mutationMap);
    } else if (state.version === 0) {
      throw new Error("Contact metadata snapshot unavailable");
    }
    if (collection.patches?.length) {
      const patches = await baileys.decodePatches(COLLECTION, collection.patches, state, getKey,
        { timeout: remaining() }, undefined, { trace() {}, debug() {}, info() {}, warn() {}, error() {} }, true);
      state = patches.state;
      Object.assign(mutations, patches.mutationMap);
    }
    for (const mutation of Object.values(mutations)) {
      const action = mutation?.syncAction?.value?.contactAction;
      const id = normalizeId(mutation?.index?.[1]);
      if (mutation?.index?.[0] !== "contact" || !id || !action) continue;
      records.set(id, { id, name: action.fullName, lid: action.lidJid });
    }
    if (!collection.hasMorePatches) return [...records.values()];
  }
  throw new Error("Contact metadata incomplete");
}

/** Keep bounded contact metadata private to one linked WhatsApp account. */
class ContactNameStore {
  #file;
  #entries = new Map();
  #owner = null;
  #loaded = false;
  #dirty = false;
  #timer;
  #writing = Promise.resolve();
  #warn;
  #maxEntries;
  #maxBytes;
  #refresh;
  #generation = 0;
  #lastRefresh = -Infinity;

  /** Store the cache beside existing session data; never recreate a deleted session. */
  constructor({ directory, onError = () => {}, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES }) {
    this.#file = path.join(directory, "contact-name-cache.json");
    this.#warn = onError;
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
  }

  /** Restore validated metadata only for the same normalized account owner. */
  async load(account) {
    if (this.#loaded) { this.setOwner(account); return; }
    this.#loaded = true;
    this.#owner = normalizeId(account);
    if (!this.#owner) return;
    try {
      if ((await fs.stat(this.#file)).size > this.#maxBytes) throw new Error("Oversized cache");
      const saved = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (saved.version !== 1 || saved.owner !== this.#owner || !Array.isArray(saved.contacts)) return;
      for (const entry of saved.contacts.slice(-this.#maxEntries)) {
        if (!Array.isArray(entry?.ids) || entry.ids.some((id) => !normalizeId(id))) continue;
        const record = { ids: new Set(entry.ids.map(normalizeId)),
          name: cleanName(entry.name), notify: cleanName(entry.notify) };
        if ([...record.ids].some((id) => this.#entries.has(id))) throw new Error("Duplicate cache alias");
        for (const id of record.ids) this.#entries.set(id, record);
        this.#evict();
      }
      this.#dirty = false;
    } catch (error) {
      this.#entries.clear();
      if (error.code !== "ENOENT") this.#warn();
    }
  }

  /** Discard cached and pending metadata when the linked account changes. */
  setOwner(account) {
    const owner = normalizeId(account);
    if (owner === this.#owner) return;
    this.#owner = owner;
    this.#generation += 1;
    this.#entries.clear();
    this.#lastRefresh = -Infinity;
    this.#changed();
  }

  /** Return a saved name or profile-name fallback and explicitly linked identifiers. */
  get(id) {
    const entry = this.#entries.get(normalizeId(id));
    return entry ? { name: entry.name || entry.notify || null, identifiers: [...entry.ids].sort() } : null;
  }

  /** Merge contact updates, preserving omitted fields and current LID identity. */
  update(contacts) {
    if (!Array.isArray(contacts)) return;
    for (const contact of contacts) {
      if (!contact || !normalizeId(contact.id)) continue;
      const ids = new Set([contact.id, contact.jid, contact.lid].map(normalizeId).filter(Boolean));
      const lids = new Set([...ids].filter((id) => id.endsWith("@lid")));
      const old = [];
      for (const entry of new Set([...ids].map((id) => this.#entries.get(id)).filter(Boolean))) {
        const conflictingLid = lids.size && [...entry.ids].some((id) => id.endsWith("@lid") && !lids.has(id));
        if (conflictingLid) {
          // A reassigned phone number must not rename or merge its previous LID.
          for (const id of ids) {
            if (entry.ids.delete(id)) this.#entries.delete(id);
          }
        } else {
          old.push(entry);
        }
      }
      for (const entry of old) for (const id of entry.ids) ids.add(id);
      const entry = { ids, name: old.find((item) => item.name)?.name || null,
        notify: old.find((item) => item.notify)?.notify || null };
      if (Object.hasOwn(contact, "name") && contact.name !== undefined) entry.name = cleanName(contact.name);
      if (Object.hasOwn(contact, "notify") && contact.notify !== undefined) entry.notify = cleanName(contact.notify);
      for (const id of ids) { this.#entries.delete(id); this.#entries.set(id, entry); }
      this.#evict();
      this.#changed();
    }
  }

  /** Evict complete contacts so no alias points to a partially removed record. */
  #evict() {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.values().next().value;
      for (const id of oldest.ids) this.#entries.delete(id);
    }
  }

  /** Resolve missing names with one shared, throttled read of current metadata. */
  async resolve(id, { socket, baileys, keys, isCurrent = () => true }) {
    if (this.get(id)?.name || !normalizeId(id) || !this.#owner) return this.get(id);
    const supported = typeof socket?.query === "function" && typeof keys?.get === "function"
      && ["newLTHashState", "extractSyncdPatches", "decodeSyncdSnapshot", "decodePatches"]
        .every((key) => typeof baileys?.[key] === "function");
    if (!supported) return this.get(id);
    if (!this.#refresh && Date.now() - this.#lastRefresh >= REFRESH_INTERVAL_MS) {
      this.#lastRefresh = Date.now();
      const owner = this.#owner;
      const generation = this.#generation;
      this.#refresh = fetchContactNames(socket, baileys, keys).then((contacts) => {
        if (isCurrent() && owner === this.#owner && generation === this.#generation) this.update(contacts);
      }).catch(() => this.#warn()).finally(() => { this.#refresh = undefined; });
    }
    if (this.#refresh) await this.#refresh;
    return this.get(id);
  }

  /** Clear names immediately and invalidate any lookup already in progress. */
  clear() { this.#generation += 1; this.#entries.clear(); this.#lastRefresh = -Infinity; this.#changed(); }

  /** Coalesce writes without keeping the process alive for persistence alone. */
  #changed() {
    this.#dirty = true;
    if (this.#timer || !this.#owner) return;
    this.#timer = setTimeout(() => { void this.flush(); }, 250);
    this.#timer.unref?.();
  }

  /** Persist a bounded snapshot atomically without recreating session directories. */
  async flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#dirty && this.#owner) {
      this.#dirty = false;
      let contacts = [...new Set(this.#entries.values())].map((entry) => ({
        ids: [...entry.ids].sort(), name: entry.name, notify: entry.notify,
      }));
      const saved = { version: 1, owner: this.#owner, contacts: [] };
      let bytes = Buffer.byteLength(JSON.stringify(saved));
      let first = contacts.length;
      for (let index = contacts.length - 1; index >= 0; index -= 1) {
        const size = Buffer.byteLength(JSON.stringify(contacts[index])) + (first < contacts.length ? 1 : 0);
        if (bytes + size > this.#maxBytes) break;
        bytes += size;
        first = index;
      }
      for (const entry of contacts.slice(0, first)) {
        for (const id of entry.ids) this.#entries.delete(id);
      }
      contacts = contacts.slice(first);
      const snapshot = JSON.stringify({ ...saved, contacts });
      this.#writing = this.#writing.then(async () => {
        try {
          await fs.writeFile(`${this.#file}.tmp`, snapshot, { mode: 0o600 });
          await fs.rename(`${this.#file}.tmp`, this.#file);
        } catch { this.#dirty = true; this.#warn(); }
      });
    }
    await this.#writing;
  }
}

module.exports = { ContactNameStore, fetchContactNames };
