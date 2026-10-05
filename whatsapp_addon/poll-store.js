const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_POLLS = 100;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_POLL_BYTES = 16 * 1024;
const MAX_IDENTITIES = 8;
const SECRET_BYTES = 32;
const USER_ID = /^\d{1,32}@(?:s\.whatsapp\.net|lid)$/;

const ownerId = (id) => typeof id === "string" ? id.replace(/:\d+@/, "@") : null;
const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 256;
const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const optionHash = (name) => crypto.createHash("sha256").update(name).digest("hex");

// Phone-number and LID identities without their device part.
const userIds = (values) =>
  [...new Set(values.map(ownerId).filter((id) => id && USER_ID.test(id)))].slice(0, MAX_IDENTITIES);

// A group or other shared chat has one stable ID. A direct chat has none: it can
// be reported as a phone number once and as a LID later, so it becomes null.
const sharedChat = (jid) => (validId(jid) && !USER_ID.test(ownerId(jid)) ? jid : null);

// Every identity the author of a message is known by. A vote's key is derived
// from the poll creator's and the voter's identity in the form the voter's
// phone used, phone number or LID, and that form is not visible in the message.
const authorIds = (key, me) => userIds([
  key?.participant, key?.participantPn, key?.participantLid, key?.senderPn, key?.senderLid,
  ...(key?.fromMe ? [me?.id, me?.lid] : key?.participant ? [] : [key?.remoteJid]),
]);

// A poll arrives as pollCreationMessage, V2 or V3. V4 and V5 wrap one of those.
const findPoll = (content, depth = 0) => {
  if (!isObject(content)) return undefined;
  for (const [name, value] of Object.entries(content)) {
    if (!name.startsWith("pollCreationMessage") || !isObject(value)) continue;
    if (Array.isArray(value.options)) return { poll: value, context: content.messageContextInfo };
    const inner = depth < 2 ? findPoll(value.message, depth + 1) : undefined;
    if (inner) return inner;
  }
  return undefined;
};

const secretOf = (poll) => Buffer.from(poll.secret, "base64");

const validPoll = (poll) =>
  isObject(poll) && typeof poll.secret === "string" && secretOf(poll).length === SECRET_BYTES &&
  typeof poll.name === "string" && typeof poll.mine === "boolean" && Number.isFinite(poll.expires) &&
  (poll.chat === null || validId(poll.chat)) &&
  Array.isArray(poll.options) && poll.options.length > 0 &&
  poll.options.every((option) => typeof option === "string" && option) &&
  Array.isArray(poll.creators) && poll.creators.every((creator) => USER_ID.test(creator)) &&
  Buffer.byteLength(JSON.stringify(poll)) <= MAX_POLL_BYTES;

// WhatsApp encrypts a vote with a secret that only the poll's own message
// carries, so the newest polls are retained, per session, to decode later votes.
// A poll is found by its message ID, and a vote must arrive in the poll's group
// or, for a direct-chat poll, in a direct chat. A lookup can never yield a wrong
// answer: a vote only decrypts with the secret of the poll it was cast on.
class PollStore {
  #file;
  #entries = new Map();
  #owner = null;
  #loaded = false;
  #dirty = false;
  #timer;
  #writing = Promise.resolve();
  #warn;
  #maxEntries;
  #ttlMs;
  #now;

  constructor({ directory, onError = () => {}, maxEntries = MAX_POLLS, ttlMs = RETENTION_MS, now = Date.now }) {
    this.#file = path.join(directory, "poll-cache.json");
    this.#warn = onError;
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
    this.#now = now;
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
      if (saved.version !== 1 || saved.owner !== this.#owner || !Array.isArray(saved.polls)) return;
      for (const entry of saved.polls.slice(-this.#maxEntries)) {
        if (Array.isArray(entry) && validId(entry[0]) && validPoll(entry[1])) {
          this.#entries.set(entry[0], entry[1]);
        }
      }
      this.#prune();
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

  /** Keeps a poll's secret, question and option names. Returns whether it was stored. */
  remember(message, { extractMessageContent }) {
    const id = message?.key?.id;
    // A replayed poll must not replace the stored one or extend its lifetime.
    if (!validId(id) || !message.message || this.#entries.has(id)) return false;
    const found = findPoll(extractMessageContent(message.message));
    if (!found) return false;
    const secret = [message.message.messageContextInfo, found.context]
      .map((context) => context?.messageSecret)
      .find((value) => value instanceof Uint8Array && value.length === SECRET_BYTES);
    if (!secret) return false;
    const poll = {
      secret: Buffer.from(secret).toString("base64"),
      name: typeof found.poll.name === "string" ? found.poll.name : "",
      options: found.poll.options.map((option) => option?.optionName),
      chat: sharedChat(message.key.remoteJid),
      mine: message.key.fromMe === true,
      creators: authorIds(message.key),
      expires: this.#now() + this.#ttlMs,
    };
    if (!validPoll(poll)) return false;
    this.#prune();
    this.#entries.set(id, poll);
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value);
    this.#changed();
    return true;
  }

  /**
   * Decodes a vote into option names. Returns undefined for a message that is
   * not a vote. Each vote carries the voter's whole current selection.
   */
  decode(message, { extractMessageContent, decryptPollVote, me }) {
    const update = extractMessageContent(message?.message)?.pollUpdateMessage;
    if (!update?.vote?.encPayload || !update.vote.encIv) return undefined;
    const pollId = update.pollCreationMessageKey?.id;
    const failed = (error) => ({ status: "error", error, ...(validId(pollId) ? { poll_id: pollId } : {}) });
    this.#prune();
    const poll = validId(pollId) ? this.#entries.get(pollId) : undefined;
    // Someone who left the group still has its polls' secrets, but can no
    // longer send a vote there.
    if (!poll || poll.chat !== sharedChat(message.key?.remoteJid)) return failed("unknown_poll");

    const creators = userIds([
      ...poll.creators,
      ...(poll.mine ? [me?.id, me?.lid] : []),
      ...authorIds(update.pollCreationMessageKey, me),
    ]);
    const pollEncKey = secretOf(poll);
    let selected;
    // A wrong identity fails the authenticated decryption; it never decodes to
    // other options.
    for (const voterJid of authorIds(message.key, me)) {
      for (const pollCreatorJid of creators) {
        try {
          selected = decryptPollVote(update.vote, { pollCreatorJid, pollMsgId: pollId, pollEncKey, voterJid })
            .selectedOptions.map((hash) => Buffer.from(hash).toString("hex"));
          break;
        } catch {
          // Try the next identity form.
        }
      }
      if (selected) break;
    }
    if (!selected) return failed("decrypt_failed");

    // A vote lists SHA-256 hashes of the selected option names.
    const hashes = poll.options.map(optionHash);
    if (selected.some((hash) => !hashes.includes(hash))) return failed("unknown_option");
    return {
      status: "ready",
      poll_id: pollId,
      poll_name: poll.name,
      selected_options: poll.options.filter((option, index) => selected.includes(hashes[index])),
    };
  }

  clear() {
    this.#entries.clear();
    this.#changed();
  }

  #prune() {
    const now = this.#now();
    for (const [id, poll] of this.#entries) {
      if (poll.expires > now) continue;
      this.#entries.delete(id);
      this.#changed();
    }
  }

  #changed() {
    this.#dirty = true;
    if (this.#timer || !this.#owner) return;
    this.#timer = setTimeout(() => { void this.flush(); }, 250);
    this.#timer.unref?.();
  }

  async flush() {
    // Also the point where an expired poll leaves the disk without new activity.
    this.#prune();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#dirty && this.#owner) {
      this.#dirty = false;
      const snapshot = JSON.stringify({ version: 1, owner: this.#owner, polls: [...this.#entries] });
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

module.exports = { PollStore };
