const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChatArchiveStore } = require("../chat-archive-store");

const OWNER = "12025550123:4@s.whatsapp.net";
const CHAT = "12025550124@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";
const fixture = async (t, options = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-archive-"));
  const errors = [];
  const store = new ChatArchiveStore({ directory, onError: (...args) => errors.push(args), ...options });
  t.after(async () => {
    await store.flush();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, errors, store, file: path.join(directory, "chat-archive-cache.json") };
};

test("explicit flags survive partial updates; unknown, malformed and conditional flags stay unknown", async (t) => {
  const { store } = await fixture(t);
  await store.load(OWNER);
  assert.equal(store.get(CHAT), null);
  store.update([{ id: CHAT, archived: true }, { id: GROUP, archived: false }]);
  store.update([{ id: CHAT, unreadCount: 1 }, { id: CHAT, archived: null },
    { id: CHAT, archived: false, conditional: () => false }, null, { archived: true }]);
  store.update(null);
  assert.equal(store.get(CHAT), true);
  assert.equal(store.get(GROUP), false);
  assert.equal(store.get("999999999999999@lid"), null);
  store.update([{ id: CHAT, archived: false }]);
  assert.equal(store.get(CHAT), false);
  store.delete([CHAT]);
  assert.equal(store.get(CHAT), null);
});

test("archive flags persist across restarts and ignore another account's saved state", async (t) => {
  const { store, directory, file } = await fixture(t);
  await store.load(OWNER);
  store.update([{ id: CHAT, archived: true, name: "Do not store", messages: ["Private text"] },
    { id: GROUP, archived: false }]);
  await store.flush();
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(saved, { version: 1, owner: "12025550123@s.whatsapp.net", chats: [[CHAT, true], [GROUP, false]] });
  const restored = new ChatArchiveStore({ directory });
  await restored.load("12025550123:9@s.whatsapp.net");
  assert.equal(restored.get(CHAT), true);
  assert.equal(restored.get(GROUP), false);
  const different = new ChatArchiveStore({ directory });
  await different.load("12025550125@s.whatsapp.net");
  assert.equal(different.get(CHAT), null);
  store.setOwner("12025550125@s.whatsapp.net");
  assert.equal(store.get(CHAT), null);
  await store.flush();
  const reloaded = new ChatArchiveStore({ directory });
  await reloaded.load(OWNER);
  assert.equal(reloaded.get(CHAT), null);
});

test("deletions and logout clearing are persisted after pending writes", async (t) => {
  const { store, directory } = await fixture(t);
  await store.load(OWNER);
  store.update([{ id: CHAT, archived: true }, { id: GROUP, archived: true }]);
  const writing = store.flush();
  store.delete([CHAT]);
  await store.flush();
  await writing;
  const restored = new ChatArchiveStore({ directory });
  await restored.load(OWNER);
  assert.equal(restored.get(CHAT), null);
  assert.equal(restored.get(GROUP), true);
  store.clear();
  await store.flush();
  const empty = new ChatArchiveStore({ directory });
  await empty.load(OWNER);
  assert.equal(empty.get(GROUP), null);
});

test("corrupt or oversized saved data is unknown and errors never contain identifiers", async (t) => {
  for (const content of ["not JSON", " ".repeat(8 * 1024 * 1024 + 1)]) {
    const { store, file, errors } = await fixture(t);
    await fs.writeFile(file, content);
    await store.load(OWNER);
    assert.equal(store.get(CHAT), null);
    assert.deepEqual(errors, [[]]);
  }
});

test("cache size is bounded and evicted chats become unknown", async (t) => {
  const { store } = await fixture(t, { maxEntries: 2 });
  await store.load(OWNER);
  store.update([{ id: CHAT, archived: true }, { id: GROUP, archived: false },
    { id: "999999999999999@lid", archived: true }]);
  assert.equal(store.get(CHAT), null);
  assert.equal(store.get(GROUP), false);
});

test("write failure preserves memory and never recreates a removed session directory", async (t) => {
  const { store, directory, errors } = await fixture(t);
  await store.load(OWNER);
  await fs.rm(directory, { recursive: true, force: true });
  store.update([{ id: CHAT, archived: true }]);
  await store.flush();
  assert.equal(store.get(CHAT), true);
  assert.deepEqual(errors, [[]]);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});
