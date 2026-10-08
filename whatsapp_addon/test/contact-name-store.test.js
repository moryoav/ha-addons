const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ContactNameStore, fetchContactNames } = require("../contact-name-store");

const OWNER = "12025550125@s.whatsapp.net";
const PN = "12025550123@s.whatsapp.net";
const LID = "999999999999999@lid";
const GROUP = "120363000000000000@g.us";
const COLLECTION = "critical_unblock_low";

/** Create an isolated account cache and remove its files after the test. */
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-contact-names-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ContactNameStore({ directory, ...options });
  await store.load(OWNER);
  t.after(() => store.flush());
  return { store, directory };
}

/** Build a signed contact snapshot using the installed Baileys cryptography. */
async function encryptedFixture() {
  const baileys = await import("@whiskeysockets/baileys");
  const keyId = Buffer.from("fictional-contact-key").toString("base64");
  const key = { keyData: Buffer.alloc(32, 7) };
  let state = baileys.newLTHashState();
  const records = [];
  let patch;
  for (const [index, syncAction] of [
    [["contact", PN], { contactAction: { fullName: "Recipient Example", lidJid: LID } }],
    [["mute", PN], { muteAction: { muted: true } }],
  ]) {
    ({ state, patch } = await baileys.encodeSyncdPatch({ type: COLLECTION, index,
      syncAction, apiVersion: 2, operation: baileys.proto.SyncdMutation.SyncdOperation.SET },
    keyId, state, async () => key));
    records.push(...patch.mutations.map((mutation) => mutation.record));
  }
  const snapshot = { version: { version: state.version }, records, keyId: patch.keyId,
    mac: patch.snapshotMac };
  const reads = [];
  const keys = { get: async (kind, ids) => {
    reads.push([kind, ids]);
    return Object.fromEntries(ids.map((id) => [id, id === keyId ? key : undefined]));
  }, set() { throw new Error("Auth keys must not be changed"); } };
  return { baileys, snapshot, keys, reads, state, keyId, key };
}

/** Feed a signed fixture through the same snapshot decoder used at runtime. */
function metadataSource(fixture, query = async () => ({})) {
  return { socket: { query }, keys: fixture.keys,
    baileys: { ...fixture.baileys, extractSyncdPatches: async () => ({
      [COLLECTION]: { snapshot: fixture.snapshot, patches: [], hasMorePatches: false },
    }) } };
}

test("saved names take priority over notify, aliases merge, partial updates preserve names", async (t) => {
  const { store } = await fixture(t);
  store.update([{ id: LID, notify: "Recipient profile" }, { id: PN, name: "Recipient Example", lid: LID }]);
  store.update([{ id: PN, notify: "New profile", name: undefined }]);
  const expected = { name: "Recipient Example", identifiers: [PN, LID] };
  assert.deepEqual(store.get(PN), expected);
  assert.deepEqual(store.get(LID.replace("@", ":2@")), expected);
  store.update([{ id: PN, name: null }]);
  assert.equal(store.get(LID).name, "New profile");
  store.update([{ id: PN, name: "Renamed contact" }]);
  assert.equal(store.get(LID).name, "Renamed contact");
});

test("group metadata and invalid identifiers never become personal contacts", async (t) => {
  const { store } = await fixture(t);
  store.update([{ id: GROUP, name: "Group", lid: LID }, { id: "status@broadcast", name: "Broadcast" },
    { id: PN, name: "  Recipient\nExample  " }]);
  assert.equal(store.get(GROUP), null);
  assert.equal(store.get(LID), null);
  assert.equal(store.get(PN).name, "Recipient Example");
  assert.equal(store.get("invalid"), null);
});

test("cache survives recreation with every alias, stays account scoped, and clears on logout", async (t) => {
  const { store, directory } = await fixture(t);
  const secondPN = "12025550126@s.whatsapp.net";
  store.update([{ id: PN, name: "Recipient Example", lid: LID, notify: "Profile" },
    { id: secondPN, lid: LID }]);
  await store.flush();
  const second = new ContactNameStore({ directory });
  await second.load(OWNER.replace("@", ":4@"));
  for (const id of [PN, LID, secondPN]) assert.deepEqual(second.get(id), store.get(id));
  second.clear();
  await second.flush();
  const third = new ContactNameStore({ directory });
  await third.load(OWNER);
  assert.equal(third.get(PN), null);
  store.setOwner("12025550126@s.whatsapp.net");
  assert.equal(store.get(PN), null);
  await store.flush();
  const other = new ContactNameStore({ directory });
  await other.load(OWNER);
  assert.equal(other.get(PN), null);
});

test("malformed cache fails closed with a generic warning", async (t) => {
  const { directory } = await fixture(t);
  await fs.writeFile(path.join(directory, "contact-name-cache.json"), "invalid json");
  let warnings = 0;
  const store = new ContactNameStore({ directory, onError: () => { warnings += 1; } });
  await store.load(OWNER);
  assert.equal(store.get(PN), null);
  assert.equal(warnings, 1);
});

test("eviction removes all aliases of the oldest contact", async (t) => {
  const { store } = await fixture(t, { maxEntries: 2 });
  store.update([{ id: PN, lid: LID, name: "First" },
    { id: "12025550126@s.whatsapp.net", name: "Second" }]);
  assert.equal(store.get(PN), null);
  assert.equal(store.get(LID), null);
  assert.equal(store.get("12025550126@s.whatsapp.net").name, "Second");
});

test("flushing cannot recreate a deleted auth directory", async (t) => {
  const { store, directory } = await fixture(t);
  store.update([{ id: PN, name: "Example" }]);
  await fs.rm(directory, { recursive: true, force: true });
  await store.flush();
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("current contact snapshot uses real Baileys crypto without auth writes or unrelated actions", async () => {
  const f = await encryptedFixture();
  const queries = [];
  const source = metadataSource(f, async (node, timeout) => { queries.push([node, timeout]); return {}; });
  const contacts = await fetchContactNames(source.socket, source.baileys, source.keys);
  assert.deepEqual(contacts, [{ id: PN, name: "Recipient Example", lid: LID }]);
  const collection = queries[0][0].content[0].content[0];
  assert.deepEqual(collection.attrs, { name: COLLECTION, version: "0", return_snapshot: "true" });
  assert.ok(queries[0][1] > 0 && queries[0][1] <= 8000);
  assert.ok(f.reads.length > 0 && f.reads.every(([kind]) => kind === "app-state-sync-key"));
});

test("contact snapshot MAC failure never returns unverified names", async () => {
  const f = await encryptedFixture();
  f.snapshot.mac = Buffer.alloc(32);
  const source = metadataSource(f);
  await assert.rejects(fetchContactNames(source.socket, source.baileys, source.keys));
});

test("later pages apply verified patches to the snapshot", async () => {
  const f = await encryptedFixture();
  const result = await f.baileys.encodeSyncdPatch({ type: COLLECTION, index: ["contact", PN],
    syncAction: { contactAction: { fullName: "New name", lidJid: LID } }, apiVersion: 2,
    operation: f.baileys.proto.SyncdMutation.SyncdOperation.SET }, f.keyId, f.state, async () => f.key);
  result.patch.version = { version: result.state.version };
  let page = 0;
  const requests = [];
  const socket = { query: async (node) => { requests.push(node); return { page: page++ }; } };
  const baileys = { ...f.baileys, extractSyncdPatches: async ({ page }) => ({ [COLLECTION]: page === 0
    ? { snapshot: f.snapshot, patches: [], hasMorePatches: true }
    : { patches: [result.patch], hasMorePatches: false } }) };
  assert.deepEqual(await fetchContactNames(socket, baileys, f.keys), [{ id: PN, name: "New name", lid: LID }]);
  assert.deepEqual(requests[1].content[0].content[0].attrs,
    { name: COLLECTION, version: "2", return_snapshot: "false" });
});

test("a missing snapshot cannot be mistaken for a complete contact collection", async () => {
  const f = await encryptedFixture();
  const baileys = { ...f.baileys, extractSyncdPatches: async () => ({ [COLLECTION]: { patches: [] } }) };
  await assert.rejects(fetchContactNames({ query: async () => ({}) }, baileys, f.keys), /snapshot unavailable/);
});

test("unknown contacts share one refresh and respect cooldown; cached names do not query", async (t) => {
  const { store } = await fixture(t);
  const f = await encryptedFixture();
  let calls = 0;
  const source = metadataSource(f, async () => { calls += 1; return {}; });
  const [first, second] = await Promise.all([store.resolve(LID, source), store.resolve(PN, source)]);
  assert.equal(first.name, "Recipient Example");
  assert.deepEqual(first, second);
  await store.resolve(PN, source);
  assert.equal(await store.resolve("12025550129@s.whatsapp.net", source), null);
  assert.equal(calls, 1);
});

test("unknown contacts keep the event usable when a lookup fails", async (t) => {
  let warnings = 0;
  const { store } = await fixture(t, { onError: () => { warnings += 1; } });
  const f = await encryptedFixture();
  let calls = 0;
  const source = metadataSource(f, async () => { calls += 1; throw new Error("private upstream detail"); });
  assert.equal(await store.resolve(PN, source), null);
  assert.equal(await store.resolve(PN, source), null);
  assert.equal(calls, 1);
  assert.equal(warnings, 1);
});

for (const change of ["logout", "owner", "socket"]) {
  test(`pending lookup cannot repopulate metadata after ${change} changes`, async (t) => {
    const { store } = await fixture(t);
    const f = await encryptedFixture();
    let release;
    let current = true;
    const source = { ...metadataSource(f, () => new Promise((resolve) => { release = resolve; })),
      isCurrent: () => current };
    const lookup = store.resolve(PN, source);
    if (change === "logout") store.clear();
    else if (change === "owner") store.setOwner("12025550126@s.whatsapp.net");
    else current = false;
    release({});
    assert.equal(await lookup, null);
    assert.equal(store.get(PN), null);
  });
}


test("byte budget evicts the oldest names and keeps the persisted cache reloadable", async (t) => {
  const { store, directory } = await fixture(t, { maxBytes: 500 });
  store.update([{ id: PN, lid: LID, name: "Old".repeat(70) },
    { id: "12025550126@s.whatsapp.net", name: "New".repeat(70) }]);
  await store.flush();
  assert.equal(store.get(PN), null);
  assert.equal(store.get(LID), null);
  assert.equal(store.get("12025550126@s.whatsapp.net").name, "New".repeat(70));
  assert.ok((await fs.stat(path.join(directory, "contact-name-cache.json"))).size <= 500);
  const restored = new ContactNameStore({ directory, maxBytes: 500 });
  await restored.load(OWNER);
  assert.deepEqual(restored.get("12025550126@s.whatsapp.net"), store.get("12025550126@s.whatsapp.net"));
});

test("an incomplete collection is bounded to five pages without returning partial names", async () => {
  const f = await encryptedFixture();
  let calls = 0;
  const source = metadataSource(f, async () => { calls += 1; return {}; });
  source.baileys.extractSyncdPatches = async () => ({ [COLLECTION]: {
    snapshot: f.snapshot, patches: [], hasMorePatches: true,
  } });
  await assert.rejects(fetchContactNames(source.socket, source.baileys, source.keys), /incomplete/);
  assert.equal(calls, 5);
});

test("snapshot reading stops after the total lookup time budget", async (t) => {
  const f = await encryptedFixture();
  t.mock.timers.enable({ apis: ["Date"] });
  const source = metadataSource(f, async () => { t.mock.timers.tick(8000); return {}; });
  await assert.rejects(fetchContactNames(source.socket, source.baileys, source.keys), /timed out/);
});


for (const savedName of [undefined, "New saved name"]) {
  test(`reassigned phone numbers keep old and new LIDs separate with ${savedName ? "a saved name" : "a profile fallback"}`, async (t) => {
    const { store } = await fixture(t);
    const nextLid = "888888888888888@lid";
    store.update([{ id: PN, lid: LID, name: "Original contact" },
      { id: nextLid, notify: "New profile" }]);
    store.update([{ id: PN, lid: nextLid, name: savedName }]);
    assert.deepEqual(store.get(LID), { name: "Original contact", identifiers: [LID] });
    assert.deepEqual(store.get(PN), { name: savedName || "New profile", identifiers: [PN, nextLid] });
    assert.deepEqual(store.get(nextLid), store.get(PN));
  });
}


test("a pending lookup never returns names learned by a replacement account", async (t) => {
  const { store } = await fixture(t);
  const f = await encryptedFixture();
  let release;
  const source = metadataSource(f, () => new Promise((resolve) => { release = resolve; }));
  const lookup = store.resolve(PN, source);
  store.setOwner("12025550126@s.whatsapp.net");
  store.update([{ id: PN, name: "Replacement account contact" }]);
  release({});
  assert.equal(await lookup, null);
  assert.equal(store.get(PN).name, "Replacement account contact");
});
