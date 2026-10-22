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
const { createAddonRuntime, parseOptions, startAddon } = require("../runtime");

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

test("an incomplete preparation resumes only after an explicit retry following app restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-prepare-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const old = await new MessageInbox({ directory, clientIds: ["default"] }).start();
  await old.enqueue("default", payload);
  const inbox = await new MessageInbox({ directory, clientIds: ["default"] }).start();
  await inbox.open(SESSION);
  await inbox.resolve((await inbox.poll(SESSION)).inbox, "retry");
  const client = new EventEmitter(); client.disconnect = async () => {}; client.status = { connected: true };
  const runtime = createAddonRuntime({ clientIds: ["default"], messageInbox: inbox,
    clientFactory: () => client, logger: {}, httpClient: { post: async () => {} },
    mediaStore: { enrich: async () => ({ status: "error", error: "invalid_metadata" }) },
  });
  client.emit("ready");
  await runtime.stopInbox();
  await inbox.open(SESSION);
  assert.equal((await inbox.poll(SESSION)).message.media.error, "invalid_metadata");
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
  assert.equal(store.available, true);
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
  await inbox.open(SESSION);
  await inbox.resolve((await inbox.poll(SESSION)).inbox, "retry");
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

for (const failure of ["capacity", "message_size", "state_size", "storage_write", "storage_latched"]) {
  test(`inbox ${failure} failure falls back to live delivery with a visible error`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-fallback-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const options = { directory, clientIds: ["default"] };
    if (failure === "capacity") options.maxPending = 0;
    if (failure === "message_size") options.maxMessageBytes = 10;
    const inbox = await new MessageInbox(options).start();
    if (failure === "state_size") inbox.maxBytes = 100;
    if (failure === "storage_write") inbox.fsPromises = { ...fs, rename: async () => { throw new Error("Fictional private path"); } };
    if (failure === "storage_latched") inbox.markUnavailable();
    const client = new EventEmitter(); client.status = { connected: true };
    const requests = []; const logs = [];
    const runtime = createAddonRuntime({ clientIds: ["default"], messageInbox: inbox,
      clientFactory: () => client, logger: { error: (...args) => logs.push(args) },
      httpClient: { post: async (url, body) => requests.push({ url, body }) },
      mediaStore: { enrich: async () => ({ status: "error", error: "download_failed" }) },
    });
    client.emit("msg", payload);
    await runtime.stopInbox();
    const delivered = requests.find(({ url }) => url.endsWith("/new_whatsapp_message"));
    assert.ok(delivered);
    assert.equal(delivered.body.key.id, payload.key.id);
    assert.equal(delivered.body.inbox, undefined);
    assert.ok(delivered.body.inbox_error.startsWith("inbox_"));
    assert.equal(delivered.body.media.error, "download_failed");
    assert.ok(requests.some(({ url }) => url.endsWith("/whatsapp_inbox_error")));
    assert.ok(requests.some(({ body }) => body.notification_id === "whatsapp_inbox_storage"));
    assert.ok(!JSON.stringify(logs).includes(payload.key.remoteJid));
    assert.ok(!JSON.stringify(logs).includes("Fictional private path"));
  });
}

test("a corrupt inbox does not prevent app startup or unrelated legacy messages", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-corrupt-start-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "inbox"));
  const file = path.join(root, "inbox", "messages.json");
  await fs.writeFile(file, '{"version":');
  const clients = {}; const requests = []; const logs = [];
  const runtime = await startAddon({ dataRoot: root, logger: { error: (...args) => logs.push(args) },
    apiTokenLoader: async () => "fictional-runtime-token",
    optionsLoader: async () => ({ clientIds: ["default", "other"], inboxClients: ["default"], logLevel: "info" }),
    diagnosticsFactory: () => ({ start: async () => {}, stop: async () => {} }),
    replayHealthDiagnosticsFn: async () => {}, readRecoveryRecordFn: async () => null,
    clientFactory: ({ path: sessionPath }) => { const client = new EventEmitter(); client.status = { connected: true };
      client.disconnect = async () => {}; clients[path.basename(sessionPath)] = client; return client; },
    httpClient: { post: async (url, body) => requests.push({ url, body }) },
    listenFn: async () => ({}), closeServerFn: async () => {},
  });
  clients.default.emit("msg", payload); clients.other.emit("msg", payload);
  await runtime.close();
  const delivered = requests.filter(({ url }) => url.endsWith("/new_whatsapp_message"));
  assert.equal(delivered.length, 2);
  assert.equal(delivered.find(({ body }) => body.clientId === "default").body.inbox_error, "inbox_storage_unavailable");
  assert.equal(delivered.find(({ body }) => body.clientId === "other").body.inbox_error, undefined);
  assert.equal(await fs.readFile(file, "utf8"), '{"version":');
  assert.ok(JSON.stringify(logs).includes("inbox storage could not be loaded"));
});

test("a damaged pinned folder does not disable unrelated media and missing files are terminal", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-isolated-media-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("Fictional attachment"); const pinned = new Set();
  const options = { root, enabled: true, logger: {}, isPinned: (id) => pinned.has(id) };
  const client = { getMediaContent: () => ({ mimetype: "audio/ogg", fileSha256: crypto.createHash("sha256").update(bytes).digest() }),
    downloadMedia: async () => Readable.from([bytes]) };
  let store = await new MediaStore(options).start();
  const broken = await store.enrich(payload, client); pinned.add(broken.id); await store.close();
  await fs.writeFile(path.join(root, broken.id, "metadata.json"), "invalid json");
  store = await new MediaStore(options).start(); t.after(() => store.close());
  assert.equal(store.available, true);
  assert.equal((await store.enrich(payload, client)).status, "ready");
  assert.equal((await store.renew(broken)).error, "inbox_media_missing");
  assert.deepEqual(await fs.readFile(broken.local_path), bytes);
  const missing = await store.enrich(payload, client); pinned.add(missing.id);
  await fs.unlink(missing.local_path);
  assert.equal((await store.renew(missing)).error, "inbox_media_missing");
});

test("temporary media read errors retry and renewal metadata is synced before rename", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-renew-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.now(); const bytes = Buffer.from("Fictional attachment");
  const store = await new MediaStore({ root, enabled: true, retentionMs: 1000, now: () => now,
    logger: {}, isPinned: () => true }).start(); t.after(() => store.close());
  const media = await store.enrich(payload, { getMediaContent: () => ({ mimetype: "audio/ogg",
    fileSha256: crypto.createHash("sha256").update(bytes).digest() }), downloadMedia: async () => Readable.from([bytes]) });
  const read = store.readMetadata.bind(store);
  store.readMetadata = async () => { throw Object.assign(new Error("Fictional private path"), { code: "EIO" }); };
  assert.equal((await store.renew(media)).error, "inbox_media_unavailable");
  store.readMetadata = read; now += 2000;
  const write = store.writeMetadata.bind(store); const calls = [];
  store.writeMetadata = async (...args) => { await write(...args); calls.push("file_synced"); };
  store.syncDirectory = async () => { calls.push("directory_synced"); };
  assert.equal((await store.renew(media)).status, "ready");
  assert.deepEqual(calls, ["file_synced", "directory_synced"]);
});

test("media preparation is bounded and rotates accounts before returning to a busy backlog", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-fair-preparation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inbox = await new MessageInbox({ directory, clientIds: ["default", "other", "third"] }).start();
  for (const [account, id] of [["default", "a1"], ["default", "a2"], ["other", "b"], ["third", "c"]]) {
    await inbox.enqueue(account, { ...payload, key: { ...payload.key, id } });
  }
  const pending = new Map(); const calls = [];
  const runtime = createAddonRuntime({ clientIds: ["default", "other", "third"], messageInbox: inbox,
    clientFactory: () => { const client = new EventEmitter(); client.status = { connected: true }; return client; },
    logger: {}, httpClient: { post: async () => {} },
    mediaStore: { enrich: async (message) => { calls.push(message.key.id);
      return new Promise((resolve) => pending.set(message.key.id, resolve)); } },
  });
  runtime.preparePendingInbox(); await settle();
  assert.deepEqual(calls, ["a1", "b"]);
  pending.get("a1")(undefined);
  for (let i = 0; i < 100 && !pending.has("c"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls, ["a1", "b", "c"]);
  const stopped = runtime.stopInbox();
  pending.get("b")(undefined); pending.get("c")(undefined); await stopped;
  assert.equal(inbox.unready("default").length, 1);
});

test("temporary media failures retry while HA is offline without any inbox polls", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-offline-retry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inbox = await new MessageInbox({ directory, clientIds: ["default"], preparationRetryMs: 5 }).start();
  const client = new EventEmitter(); client.status = { connected: true }; let attempts = 0;
  const runtime = createAddonRuntime({ clientIds: ["default"], messageInbox: inbox,
    clientFactory: () => client, logger: {},
    httpClient: { post: async () => { throw new Error("Fictional HA outage"); } },
    mediaStore: { enrich: async () => { attempts++;
      if (attempts === 1) throw new Error("Fictional download failure");
      return { status: "ready", id: "1bcdfb31-7cd3-47df-8595-17fcaf84943a" }; } },
  });
  client.emit("msg", payload);
  for (let i = 0; i < 100 && !inbox.state.entries[0]?.ready; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await runtime.stopInbox(); await inbox.open(SESSION);
  assert.equal(attempts, 2);
  assert.equal((await inbox.poll(SESSION)).message.media.status, "ready");
});
