const assert = require("node:assert/strict");
const test = require("node:test");
const { ContactSnapshotError, fetchContactSnapshot, validateContactList } =
  require("../contact-snapshot");

const COLLECTION = "critical_unblock_low";
const JID = "12025550123@s.whatsapp.net";
const OTHER_JID = "12025550124@s.whatsapp.net";
const LID = "999999999999999@lid";

/** Build fictional encrypted app-state records using the pinned Baileys encoder. */
async function fixture() {
  const baileys = await import("@whiskeysockets/baileys");
  const keyId = Buffer.from("fictional-key").toString("base64");
  const key = { keyData: Buffer.alloc(32, 7) };
  const savedState = { version: 400, hash: Buffer.alloc(128, 4), indexValueMap: {} };
  const calls = [];
  const records = [];
  let state = baileys.newLTHashState();
  let latest;

  /** Encrypt a fictional contact update or removal with valid authentication MACs. */
  async function encode(id, fields, operation = baileys.proto.SyncdMutation.SyncdOperation.SET) {
    latest = await baileys.encodeSyncdPatch({ type: COLLECTION,
      index: ["contact", id], syncAction: { contactAction: fields },
      apiVersion: 2, operation }, keyId, state, async () => key);
    state = latest.state;
    return { ...latest.patch, version: { version: state.version } };
  }

  const fields = { fullName: "Example Saved Name", firstName: "Example",
    lidJid: LID, pnJid: JID, username: "example", saveOnPrimaryAddressbook: false };
  records.push((await encode(JID, fields)).mutations[0].record);
  records.push((await encode(OTHER_JID, { fullName: "Removed Contact" })).mutations[0].record);
  const snapshot = { records, version: { version: state.version },
    mac: latest.patch.snapshotMac, keyId: latest.patch.keyId };
  const rename = await encode(JID, { ...fields, fullName: "Updated Saved Name" });
  const remove = await encode(OTHER_JID, { fullName: "Removed Contact" },
    baileys.proto.SyncdMutation.SyncdOperation.REMOVE);
  const batches = [{ snapshot, patches: [], hasMorePatches: true },
    { patches: [rename, remove], hasMorePatches: false }];
  const socket = { authState: { keys: {
    /** Permit only key reads; any attempt to change sync state fails the test. */
    async get(type, ids) {
      assert.equal(type, "app-state-sync-key");
      assert.deepEqual(ids, [keyId]);
      return { [keyId]: key };
    },
    async set() { assert.fail("Snapshot must not write authentication state"); },
  } },
  /** Record the query and supply an app-state response without network access. */
  async query(query, timeout) {
    calls.push({ query, timeout });
    return { tag: "iq", attrs: {}, content: [{ tag: "sync", attrs: {}, content: [
      { tag: "collection", attrs: { name: COLLECTION } },
    ] }], batch: batches.shift() };
  },
  ev: { emit() { assert.fail("Snapshot must not replay sync events"); } } };
  return { socket, calls, fields, savedState, snapshot, batches,
    baileys: { ...baileys,
      /** Substitute downloaded data while retaining Baileys' real crypto decoders. */
      async extractSyncdPatches(reply, options) {
        assert.ok(options.timeout > 0 && options.timeout <= 60_000);
        assert.ok(options.signal instanceof AbortSignal);
        return { [COLLECTION]: reply.batch };
      },
    } };
}

test("snapshot verifies real Baileys records, follows patches and excludes removed contacts", async () => {
  const f = await fixture();
  const before = JSON.stringify(f.savedState);
  const contacts = await fetchContactSnapshot(f.socket, f.baileys);
  assert.deepEqual(contacts, [{ id: JID,
    fields: { ...f.fields, fullName: "Updated Saved Name" } }]);
  assert.equal(JSON.stringify(f.savedState), before);
  assert.deepEqual(f.calls.map(({ query }) => query.content[0].content[0].attrs), [
    { name: COLLECTION, version: "0", return_snapshot: "true" },
    { name: COLLECTION, version: "2", return_snapshot: "false" },
  ]);
  assert.ok(f.calls.every(({ timeout }) => timeout > 0 && timeout <= 60_000));
});

test("snapshot MAC failures reject the entire response", async () => {
  const f = await fixture();
  f.snapshot.mac = Buffer.alloc(32);
  await assert.rejects(fetchContactSnapshot(f.socket, f.baileys), /verify LTHash/);
});

test("patch MAC failures reject the entire response", async () => {
  const f = await fixture();
  f.batches[1].patches[0].patchMac = Buffer.alloc(32);
  await assert.rejects(fetchContactSnapshot(f.socket, f.baileys), /Invalid patch mac/);
});

test("missing keys fail without changing the auth store", async () => {
  const f = await fixture();
  f.socket.authState.keys.get = async () => ({});
  await assert.rejects(fetchContactSnapshot(f.socket, f.baileys), /failed to find key/);
});

test("unrelated app-state actions do not become contacts", async () => {
  const f = await fixture();
  f.baileys.decodeSyncdSnapshot = async () => ({ state: { version: 1 }, mutationMap: {
    other: { index: ["mute", JID], syncAction: { value: { contactAction: f.fields } } },
  } });
  f.batches[0].hasMorePatches = false;
  assert.deepEqual(await fetchContactSnapshot(f.socket, f.baileys), []);
});

test("missing or rejected collections cannot look like a successful empty contact list", async () => {
  for (const content of [[], [{ tag: "collection", attrs: { name: COLLECTION, type: "error" } }],
    [{ tag: "collection", attrs: { name: COLLECTION }, content: [{ tag: "error", attrs: {} }] }]]) {
    const f = await fixture();
    f.socket.query = async () => ({ tag: "iq", attrs: {}, content: [{ tag: "sync", attrs: {}, content }] });
    await assert.rejects(fetchContactSnapshot(f.socket, f.baileys), ContactSnapshotError);
  }
});

test("pagination without version progress fails instead of returning a partial list", async () => {
  const f = await fixture();
  f.batches[0] = { patches: [], hasMorePatches: true };
  await assert.rejects(fetchContactSnapshot(f.socket, f.baileys), ContactSnapshotError);
});

test("pagination is bounded even when WhatsApp repeatedly reports more pages", async () => {
  const f = await fixture();
  f.batches.splice(0, f.batches.length, ...Array.from({ length: 12 }, () =>
    ({ snapshot: {}, patches: [], hasMorePatches: true })));
  let version = 0;
  f.baileys.decodeSyncdSnapshot = async () => ({ state: { version: ++version }, mutationMap: {} });
  await assert.rejects(fetchContactSnapshot(f.socket, f.baileys), ContactSnapshotError);
  assert.equal(f.calls.length, 12);
});

test("elapsed snapshot deadlines prevent further queries", async (t) => {
  const f = await fixture();
  let time = 0;
  t.mock.method(Date, "now", () => (time += 60_001));
  await assert.rejects(fetchContactSnapshot(f.socket, f.baileys), { statusCode: 408 });
  assert.equal(f.calls.length, 0);
});

test("contact validation retains optional fields and rejects invalid records", () => {
  const fields = { fullName: null, lidJid: null, extra: { value: true } };
  const result = validateContactList([{ id: JID, fields, secret: "discard" }]);
  assert.deepEqual(result, [{ id: JID, fields }]);
  result[0].fields.extra.value = false;
  assert.equal(fields.extra.value, true);
  for (const value of [null, {}, [null], [{ id: "x", fields: {} }],
    [{ id: JID, fields: [] }], [{ id: JID, fields: { fullName: 1 } }],
    [{ id: JID, fields: { saveOnPrimaryAddressbook: 1 } }],
    [{ id: JID, fields: {} }, { id: JID, fields: {} }]]) {
    assert.throws(() => validateContactList(value), ContactSnapshotError);
  }
});


test("an authenticated empty snapshot returns an empty contact list", async () => {
  const f = await fixture();
  const keyId = Buffer.from("fictional-key").toString("base64");
  const getKey = async () => ({ keyData: Buffer.alloc(32, 7) });
  const added = await f.baileys.encodeSyncdPatch({ type: COLLECTION,
    index: ["contact", JID], syncAction: { contactAction: f.fields }, apiVersion: 2,
    operation: f.baileys.proto.SyncdMutation.SyncdOperation.SET },
    keyId, f.baileys.newLTHashState(), getKey);
  const removed = await f.baileys.encodeSyncdPatch({ type: COLLECTION,
    index: ["contact", JID], syncAction: { contactAction: f.fields }, apiVersion: 2,
    operation: f.baileys.proto.SyncdMutation.SyncdOperation.REMOVE },
    keyId, added.state, getKey);
  f.batches.splice(0, f.batches.length, { patches: [], hasMorePatches: false,
    snapshot: { records: [], version: { version: removed.state.version },
      mac: removed.patch.snapshotMac, keyId: removed.patch.keyId } });
  assert.deepEqual(await fetchContactSnapshot(f.socket, f.baileys), []);
});
