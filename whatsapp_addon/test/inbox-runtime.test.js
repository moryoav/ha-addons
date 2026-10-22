const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const { MessageInbox } = require("../message-inbox");
const { MediaStore } = require("../media-store");
const { createAddonRuntime, parseOptions } = require("../runtime");

const payload = { key: { id: "fictional-audio", remoteJid: "12025550123@s.whatsapp.net", fromMe: false },
  type: "audioMessage", message: { audioMessage: { ptt: false } } };
const SESSION = "a".repeat(32);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("inbox configuration is opt-in and only accepts configured accounts", () => {
  assert.deepEqual(parseOptions(JSON.stringify({ clients: ["default"], inbox_clients: ["default"] })).inboxClients, ["default"]);
  for (const value of [true, "default", ["missing"], ["default", "default"]]) {
    assert.throws(() => parseOptions(JSON.stringify({ clients: ["default"], inbox_clients: value })));
  }
  assert.equal(parseOptions(JSON.stringify({ clients: ["default"] })).inboxClients, undefined);
});

test("incoming audio is durable before enrichment and survives failed HA event delivery", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-runtime-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inbox = await new MessageInbox({ directory, clientIds: ["default"] }).start();
  const client = new EventEmitter(); client.disconnect = async () => {}; client.status = { connected: true };
  const requests = []; const logs = []; let finishMedia;
  const runtime = createAddonRuntime({ clientIds: ["default"], messageInbox: inbox,
    clientFactory: () => client, logger: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    mediaStore: { enrich: async () => {
      assert.equal(inbox.unready("default").length, 1);
      return new Promise((resolve) => { finishMedia = resolve; });
    } },
    httpClient: { post: async (url) => { requests.push(url); throw new Error("private request detail"); } },
  });
  client.emit("msg", payload);
  for (let i = 0; i < 100 && !finishMedia; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(finishMedia);
  assert.ok((await fs.readFile(inbox.file, "utf8")).includes("fictional-audio"));
  finishMedia({ status: "ready", id: "1bcdfb31-7cd3-47df-8595-17fcaf84943a" });
  await runtime.stopInbox();
  assert.ok(requests.every((url) => !url.endsWith("/new_whatsapp_message")));
  await inbox.open(SESSION);
  assert.equal((await inbox.poll(SESSION)).message.message.audioMessage.ptt, false);
  assert.ok(!JSON.stringify(logs).includes("private request detail"));
  assert.ok(!JSON.stringify(logs).includes(payload.key.remoteJid));
});

test("an unprepared message resumes when its WhatsApp client becomes ready", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-prepare-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const old = await new MessageInbox({ directory, clientIds: ["default"] }).start();
  await old.enqueue("default", payload);
  const inbox = await new MessageInbox({ directory, clientIds: ["default"] }).start();
  const client = new EventEmitter(); client.disconnect = async () => {}; client.status = { connected: true };
  const runtime = createAddonRuntime({ clientIds: ["default"], messageInbox: inbox,
    clientFactory: () => client, logger: {}, httpClient: { post: async () => {} },
    mediaStore: { enrich: async () => ({ status: "error", error: "download_failed" }) },
  });
  client.emit("ready");
  await runtime.stopInbox();
  await inbox.open(SESSION);
  assert.equal((await inbox.poll(SESSION)).message.media.error, "download_failed");
});

test("missing or disconnected clients leave audio unprepared until the ready event", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-client-ready-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inbox = await new MessageInbox({ directory, clientIds: ["default"] }).start();
  await inbox.enqueue("default", payload);
  const client = new EventEmitter(); client.status = { connected: false };
  let calls = 0;
  const runtime = createAddonRuntime({ clientIds: ["default"], messageInbox: inbox,
    clientFactory: () => client, logger: {}, httpClient: { post: async () => {} },
    mediaStore: { enrich: async () => { calls++; return { status: "ready", id: "1bcdfb31-7cd3-47df-8595-17fcaf84943a" }; } },
  });
  runtime.preparePendingInbox(); await settle();
  assert.equal(calls, 0);
  delete runtime.clients.default;
  runtime.preparePendingInbox(); await settle();
  assert.equal(calls, 0);
  assert.equal(inbox.unready("default").length, 1);
  runtime.clients.default = client; client.status.connected = true; client.emit("ready");
  await runtime.stopInbox(); await inbox.open(SESSION);
  assert.equal(calls, 1);
  assert.equal((await inbox.poll(SESSION)).message.media.status, "ready");
});

test("unselected accounts keep the existing live event path", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-legacy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inbox = await new MessageInbox({ directory, clientIds: ["other"] }).start();
  const client = new EventEmitter(); const requests = [];
  createAddonRuntime({ clientIds: ["default"], messageInbox: inbox, logger: {},
    clientFactory: () => client, httpClient: { post: async (...args) => requests.push(args) } });
  client.emit("msg", payload); await settle();
  assert.equal(requests[0][0], "http://supervisor/core/api/events/new_whatsapp_message");
});

test("pending attachment protection and renewed expiry survive media-store restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-media-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.now(); const bytes = Buffer.from("Fictional media"); const pinned = new Set();
  const options = { root: path.join(root, "media"), enabled: true, retentionMs: 1000,
    now: () => now, isPinned: (id) => pinned.has(id), logger: {} };
  let store = await new MediaStore(options).start();
  const media = await store.enrich(payload, {
    getMediaContent: () => ({ mimetype: "audio/ogg", fileSha256: crypto.createHash("sha256").update(bytes).digest() }),
    downloadMedia: async () => Readable.from([bytes]),
  });
  assert.equal(media.status, "ready"); pinned.add(media.id); await store.close(); now += 2000;
  store = await new MediaStore(options).start(); t.after(() => store.close());
  assert.deepEqual(await fs.readFile(media.local_path), bytes);
  const renewed = await store.renew(media);
  assert.ok(Date.parse(renewed.expires_at) > now);
  assert.equal((await store.renew(media)).expires_at, renewed.expires_at);
  pinned.delete(media.id); now += 2000; await store.cleanup();
  await assert.rejects(fs.stat(media.local_path), { code: "ENOENT" });
});

test("temporary metadata unavailability during scan cannot delete a pinned attachment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-media-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("Fictional pending attachment"); const pinned = new Set();
  const options = { root, enabled: true, isPinned: (id) => pinned.has(id), logger: {} };
  let store = await new MediaStore(options).start();
  const media = await store.enrich(payload, {
    getMediaContent: () => ({ mimetype: "audio/ogg", fileSha256: crypto.createHash("sha256").update(bytes).digest() }),
    downloadMedia: async () => Readable.from([bytes]),
  });
  pinned.add(media.id); await store.close();
  const metadata = path.join(root, media.id, "metadata.json");
  await fs.rename(metadata, metadata+".saved");
  store = await new MediaStore(options).start(); t.after(() => store.close());
  assert.equal(store.available, false);
  assert.deepEqual(await fs.readFile(media.local_path), bytes);
  await fs.rename(metadata+".saved", metadata); await store.cleanup();
  assert.equal(store.available, true);
  assert.equal((await store.renew(media)).status, "ready");
});

test("persisted media keys and hashes retain their byte types for actual audio decoding", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-audio-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("Fictional decrypted audio bytes");
  const audio = { ...payload, message: { audioMessage: { ptt: false, mimetype: "audio/ogg",
    fileSha256: crypto.createHash("sha256").update(bytes).digest(),
    mediaKey: new Uint8Array([1, 2, 3, 4]) } } };
  const directory = path.join(root, "inbox");
  const original = await new MessageInbox({ directory, clientIds: ["default"] }).start();
  await original.enqueue("default", audio);
  const inbox = await new MessageInbox({ directory, clientIds: ["default"] }).start();
  const mediaStore = await new MediaStore({ root: path.join(root, "media"), enabled: true,
    isPinned: (id) => inbox.isMediaPinned(id), logger: {} }).start();
  t.after(() => mediaStore.close());
  const client = new EventEmitter(); client.disconnect = async () => {}; client.status = { connected: true };
  client.getMediaContent = (message) => message.message.audioMessage;
  client.downloadMedia = async (message) => {
    assert.ok(Buffer.isBuffer(message.message.audioMessage.fileSha256));
    assert.deepEqual([...message.message.audioMessage.mediaKey], [1, 2, 3, 4]);
    return Readable.from([bytes]);
  };
  const runtime = createAddonRuntime({ clientIds: ["default"], messageInbox: inbox, mediaStore,
    clientFactory: () => client, logger: {}, httpClient: { post: async () => {} } });
  client.emit("ready"); await runtime.stopInbox(); await inbox.open(SESSION);
  const result = await inbox.poll(SESSION);
  assert.equal(result.message.media.status, "ready");
  assert.deepEqual(await fs.readFile(result.message.media.local_path), bytes);
});
