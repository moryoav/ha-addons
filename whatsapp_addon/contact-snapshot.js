"use strict";

const COLLECTION = "critical_unblock_low";
const SNAPSHOT_TIMEOUT_MS = 60_000;
const MAX_PAGES = 12;
const PERSON_JID = /^(?:[1-9]\d{4,14}@s\.whatsapp\.net|[1-9]\d{4,30}@lid)$/;

/** Report invalid or incomplete snapshots without exposing contact data. */
class ContactSnapshotError extends Error {
  /** Create a privacy-safe snapshot error. */
  constructor() {
    super("The contact snapshot is invalid or incomplete.");
    this.name = "ContactSnapshotError";
  }
}

/** Validate contact records and detach their original ContactAction fields. */
function validateContactList(contacts) {
  if (!Array.isArray(contacts)) throw new ContactSnapshotError();
  const seen = new Set();
  return contacts.map((contact) => {
    const { id, fields } = contact || {};
    if (typeof id !== "string" || !PERSON_JID.test(id) || seen.has(id) ||
        !fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new ContactSnapshotError();
    }
    seen.add(id);
    for (const key of ["fullName", "firstName", "lidJid", "pnJid", "username"]) {
      if (fields[key] != null && typeof fields[key] !== "string") {
        throw new ContactSnapshotError();
      }
    }
    if (fields.saveOnPrimaryAddressbook != null &&
        typeof fields.saveOnPrimaryAddressbook !== "boolean") {
      throw new ContactSnapshotError();
    }
    return { id, fields: JSON.parse(JSON.stringify(fields)) };
  });
}

/** Fetch and verify saved contacts using a disposable app-state cursor. */
async function fetchContactSnapshot(socket, baileys) {
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS);
  const contacts = new Map();
  let state = baileys.newLTHashState();

  /** Read existing app-state keys without modifying the active auth store. */
  async function getKey(id) {
    return (await socket.authState.keys.get("app-state-sync-key", [id]))[id];
  }

  /** Apply saved-contact records, including removals from subsequent patches. */
  function applyMutation(mutation, remove = false) {
    if (mutation.index?.[0] !== "contact") return;
    const id = mutation.index[1];
    if (remove) {
      contacts.delete(id);
      return;
    }
    const fields = mutation.syncAction?.value?.contactAction;
    if (fields) contacts.set(id, { id, fields });
  }

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw Object.assign(new Error("Contact snapshot timed out."), { statusCode: 408 });
    }
    const version = state.version;
    const reply = await socket.query({
      tag: "iq",
      attrs: { to: "s.whatsapp.net", xmlns: "w:sync:app:state", type: "set" },
      content: [{ tag: "sync", attrs: {}, content: [{
        tag: "collection",
        attrs: { name: COLLECTION, version: String(version),
          return_snapshot: String(version === 0) },
      }] }],
    }, remaining);
    const options = { timeout: Math.max(1, deadline - Date.now()), signal };
    const collectionNode = baileys.getBinaryNodeChildren(
      baileys.getBinaryNodeChild(reply, "sync"), "collection"
    ).find((node) => node.attrs.name === COLLECTION);
    if (!collectionNode || collectionNode.attrs.type === "error" || collectionNode.attrs.error ||
        baileys.getBinaryNodeChild(collectionNode, "error")) {
      throw new ContactSnapshotError();
    }
    const batch = (await baileys.extractSyncdPatches(reply, options))[COLLECTION];
    if (!batch || (version === 0 && !batch.snapshot && !batch.patches.length)) {
      throw new ContactSnapshotError();
    }
    if (batch.snapshot) {
      const decoded = await baileys.decodeSyncdSnapshot(
        COLLECTION, batch.snapshot, getKey, undefined, true
      );
      state = decoded.state;
      contacts.clear();
      Object.values(decoded.mutationMap).forEach((mutation) => applyMutation(mutation));
    }
    for (const patch of batch.patches) {
      const previous = state;
      // decodePatches appends external mutations, then replaces this array.
      const mutations = patch.mutations || (patch.mutations = []);
      const decoded = await baileys.decodePatches(
        COLLECTION, [patch], state, getKey, options, undefined, undefined, true
      );
      state = decoded.state;
      let position = 0;
      // Baileys' returned mutation map omits SET/REMOVE. Decode the verified
      // records again to retain that operation without reimplementing crypto.
      /** Preserve the operation associated with each decoded patch record. */
      function applyPatchMutation(mutation) {
        const remove = mutations[position++].operation ===
          baileys.proto.SyncdMutation.SyncdOperation.REMOVE;
        applyMutation(mutation, remove);
      }
      await baileys.decodeSyncdMutations(
        mutations, previous, getKey, applyPatchMutation, true
      );
    }
    if (!batch.hasMorePatches) {
      return validateContactList([...contacts.values()]).sort((a, b) =>
        a.id.localeCompare(b.id)
      );
    }
    if (state.version <= version) throw new ContactSnapshotError();
  }
  throw new ContactSnapshotError();
}

module.exports = { ContactSnapshotError, fetchContactSnapshot, validateContactList, SNAPSHOT_TIMEOUT_MS };
