const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MessageInbox } = require("../message-inbox");
const { createAddonRuntime, parseOptions, startAddon } = require("../runtime");

/** Build an ordinary incoming message with fictional private metadata. */
const message = (id = "fictional-id") => ({
  key: { id, remoteJid: "12025550123@s.whatsapp.net", fromMe: false },
  type: "conversation", messageTimestamp: 1234567890,
  message: { conversation: "Fictional private content" },
});

/** Isolate each durable queue outside the repository and remove it afterward. */
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-inbox-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const create = () => new MessageInbox({ directory, ...options });
  const inbox = await create().start();
  return { inbox, create, directory };
}

test("pending messages survive app restarts in order, preserving sender and group metadata", async (t) => {
  const { inbox, create } = await fixture(t);
  const original = { ...message(), key: { ...message().key, remoteJid: "12025550123-1@g.us", participant: "999999999999999@lid" } };
  await inbox.enqueue("default", original); await inbox.enqueue("default", message("second"));
  const restarted = await create().start();
  assert.deepEqual(restarted.peek(() => true).payload, original);
  const id = restarted.peek(() => true).id;
  await restarted.delivered(id);
  assert.equal(restarted.peek(() => true).payload.key.id, "second");
  await restarted.enqueue("default", original);
  assert.equal(restarted.state.pending.length, 1);
  const saved = await fs.readFile(restarted.file, "utf8");
  assert.ok(!saved.includes("participant"));
  assert.equal((await create().start()).state.delivered[0].id, id);
});

test("concurrent admissions serialize, suppress duplicates, and preserve binary media keys", async (t) => {
  const { inbox, create } = await fixture(t);
  const original = { ...message(), message: { audioMessage: { ptt: false, mediaKey: Buffer.from([1, 2]), fileSha256: new Uint8Array([3, 4]), fileLength: 42n } } };
  await Promise.all(Array.from({ length: 12 }, () => inbox.enqueue("default", original)));
  assert.equal(inbox.state.pending.length, 1);
  const payload = (await create().start()).peek(() => true).payload;
  assert.deepEqual(payload.message.audioMessage.mediaKey, Buffer.from([1, 2]));
  assert.deepEqual(payload.message.audioMessage.fileSha256, Buffer.from([3, 4]));
  assert.equal(payload.message.audioMessage.fileLength, "42");
  payload.key.id = "changed";
  assert.equal(inbox.peek(() => true).payload.key.id, "fictional-id");
});

test("capacity and payload limits never evict queued messages", async (t) => {
  const { inbox } = await fixture(t, { maxPending: 1, maxMessageBytes: 300 });
  await inbox.enqueue("default", message());
  await assert.rejects(inbox.enqueue("default", message("second")), /full/);
  assert.throws(() => inbox.enqueue("default", { ...message(), message: { conversation: "x".repeat(400) } }), /too large/);
  const before = await fs.readFile(inbox.file, "utf8");
  for (const value of [{}, { ...message(), key: { ...message().key, fromMe: true } }]) {
    assert.throws(() => inbox.enqueue("default", value));
  }
  assert.equal(await fs.readFile(inbox.file, "utf8"), before);
  await inbox.delivered(inbox.peek(() => true).id);
  await inbox.enqueue("default", message("second"));
  assert.equal(inbox.state.pending.length, 1);
});

test("existing duplicate rules preserve changed payloads and ignore routing and media URL changes", async (t) => {
  const { inbox } = await fixture(t);
  await inbox.enqueue("default", message());
  await inbox.enqueue("default", { ...message(), key: { ...message().key, remoteJid: "999999999999999@lid" } });
  assert.equal(inbox.state.pending.length, 1);
  await inbox.enqueue("default", { ...message(), message: { conversation: "Corrected content" } });
  assert.equal(inbox.state.pending.length, 2);
  const audio = { ...message(), type: "audioMessage", message: { audioMessage: { mediaKey: Buffer.from([1, 2]), url: "https://example.invalid/first", mimetype: "audio/ogg" } } };
  await inbox.enqueue("default", audio);
  await inbox.enqueue("default", { ...audio, message: { audioMessage: { ...audio.message.audioMessage, url: "https://example.invalid/renewed" } } });
  assert.equal(inbox.state.pending.length, 3);
});

test("unreadable or invalid snapshots are preserved, and oversize state is refused before reading", async (t) => {
  const { inbox, create } = await fixture(t);
  for (const raw of ['{"version":', '{"version":1,"pending":[null],"delivered":[]}', '{"version":2,"pending":[],"delivered":[]}']) {
    await fs.writeFile(inbox.file, raw);
    const broken = create();
    await assert.rejects(broken.start(), /original files are preserved/);
    assert.equal(broken.failed, true);
    assert.equal(await fs.readFile(inbox.file, "utf8"), raw);
  }
  const limited = new MessageInbox({ directory: inbox.directory, maxBytes: 2,
    fsPromises: { ...fs, readFile: async () => { assert.fail("Oversized state must not be read"); } } });
  await assert.rejects(limited.start());
});

for (const stage of ["open", "writeFile", "sync", "rename", "directory"]) {
  test(`a failed ${stage} cannot overwrite uncertain state with later writes`, async (t) => {
    const { inbox, create } = await fixture(t); await inbox.enqueue("default", message());
    const previous = await fs.readFile(inbox.file, "utf8");
    inbox.fsPromises = { ...fs, open: async (...args) => {
      if (stage === "open") throw new Error("Fictional failure");
      const handle = await fs.open(...args);
      if (stage === "writeFile" || stage === "sync") {
        const original = handle[stage].bind(handle);
        handle[stage] = async () => { throw new Error("Fictional failure"); };
        assert.equal(typeof original, "function");
      }
      return handle;
    }, rename: stage === "rename" ? async () => { throw new Error("Fictional failure"); } : fs.rename };
    if (stage === "directory") inbox.syncDirectory = async () => { throw new Error("Fictional failure"); };
    await assert.rejects(inbox.enqueue("default", message("second")), /could not be saved/);
    const uncertain = await fs.readFile(inbox.file, "utf8");
    if (stage !== "directory") assert.equal(uncertain, previous);
    await assert.rejects(inbox.enqueue("default", message("third")), /unavailable/);
    assert.equal(await fs.readFile(inbox.file, "utf8"), uncertain);
    const restarted = await create().start();
    assert.equal(restarted.peek(() => true).payload.key.id, "fictional-id");
  });
}

test("private permissions and symlink checks protect queued payloads", { skip: process.platform === "win32" }, async (t) => {
  const { inbox, create, directory } = await fixture(t); await inbox.enqueue("default", message());
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(inbox.file)).mode & 0o777, 0o600);
  await fs.rename(inbox.file, path.join(directory, "original.json"));
  await fs.symlink(path.join(directory, "original.json"), inbox.file);
  await assert.rejects(create().start());
});

test("compact receipts are bounded and expire without retaining completed payloads", async (t) => {
  let now = 1000; const { inbox } = await fixture(t, { now: () => now });
  await inbox.update((next) => { next.delivered = Array.from({ length: 1005 }, (_, index) => ({ id: index.toString(16).padStart(64, "0"), at: now })); return true; });
  assert.equal(inbox.state.delivered.length, 1000);
  now += 8 * 86400000;
  await inbox.enqueue("default", message());
  assert.equal(inbox.state.delivered.length, 0);
  await inbox.delivered(inbox.peek(() => true).id);
  assert.ok(!(await fs.readFile(inbox.file, "utf8")).includes("Fictional private"));
});

test("persistent inbox selection is opt-in and validates configured account IDs", () => {
  assert.equal(parseOptions(JSON.stringify({ clients: ["default"] })).inboxClients, undefined);
  assert.deepEqual(parseOptions(JSON.stringify({ clients: ["default"], inbox_clients: ["default"] })).inboxClients, ["default"]);
  for (const value of [true, "default", ["missing"], ["default", "default"]]) {
    assert.throws(() => parseOptions(JSON.stringify({ clients: ["default"], inbox_clients: value })));
  }
});

test("the app waits for the integration, then retries the same event without changing its payload", async (t) => {
  const { inbox, create } = await fixture(t); const timers = []; const posts = []; const logs = [];
  let reachable = false; let accept = false; let downloads = 0;
  const client = new EventEmitter(); client.status = { connected: true };
  const runtime = createAddonRuntime({ clientIds: ["default"], inboxClients: ["default"], messageInbox: inbox,
    clientFactory: () => client, logger: { error: (...args) => logs.push(args) },
    setTimeoutFn: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimeoutFn: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    mediaStore: { enrich: async () => { downloads++; return { status: "ready", id: "fictional-media" }; } },
    httpClient: {
      get: async (_, options) => { assert.equal(options.timeout, 10000); if (!reachable) throw new Error("Private response"); return { data: { ready: true } }; },
      post: async (url, body, options) => { posts.push({ url, body, options }); if (!accept) throw new Error("Private response"); },
    } });
  t.after(() => runtime.stopInbox());
  client.emit("msg", message());
  await new Promise((resolve) => setImmediate(resolve)); await inbox.close();
  assert.equal((await create().start()).state.pending.length, 1);
  await timers.shift().fn();
  assert.equal(downloads, 0); assert.equal(posts.length, 0);
  reachable = true;
  assert.equal(timers[0].delay, 10000); await timers.shift().fn();
  assert.equal(inbox.state.pending.length, 1);
  accept = true; await timers.shift().fn();
  assert.equal(inbox.state.pending.length, 0);
  assert.equal(posts.length, 2); assert.equal(posts[0].body.id, posts[1].body.id);
  assert.equal(posts[1].url, "http://supervisor/core/api/whatsapp/inbox");
  assert.deepEqual(posts[1].body.message, { ...message(), media: { status: "ready", id: "fictional-media" }, clientId: "default" });
  assert.equal(posts[1].options.timeout, 10000);
  assert.ok(!JSON.stringify(logs).includes("Private response"));
});

test("delivery is paced and disconnected accounts do not block other accounts", async (t) => {
  const { inbox } = await fixture(t); const timers = []; const posts = []; const live = [];
  await inbox.enqueue("offline", message("first"));
  await inbox.enqueue("default", message("second")); await inbox.enqueue("default", message("third"));
  const clients = {};
  const runtime = createAddonRuntime({ clientIds: ["offline", "default", "live"], inboxClients: ["offline", "default"], messageInbox: inbox, logger: {},
    clientFactory: ({ path: sessionPath }) => { const client = new EventEmitter(); client.status = { connected: path.basename(sessionPath) === "default" }; clients[path.basename(sessionPath)] = client; return client; },
    setTimeoutFn: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; }, clearTimeoutFn: () => {},
    httpClient: { get: async () => ({ data: { ready: true } }), post: async (url, body) => (url.endsWith("/events/new_whatsapp_message") ? live : posts).push(body) } });
  t.after(() => runtime.stopInbox());
  clients.live.emit("msg", message("live")); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(live, [{ clientId: "live", ...message("live") }]);
  await timers.shift().fn(); assert.equal(posts.length, 1); assert.equal(posts[0].message.key.id, "second");
  assert.equal(timers[0].delay, 10000); await timers.shift().fn();
  assert.equal(posts[1].message.key.id, "third");
  clients.offline.status.connected = true; await timers.shift().fn();
  assert.equal(posts[2].message.key.id, "first");
  assert.equal(inbox.state.pending.length, 0);
});

for (const unavailable of [false, true]) {
  test(`storage ${unavailable ? "failure" : "capacity"} preserves the backlog and falls back to live delivery`, async (t) => {
    const { inbox } = await fixture(t, { maxPending: 1 }); await inbox.enqueue("default", message());
    inbox.failed = unavailable;
    const client = new EventEmitter(); const posts = []; const logs = [];
    const runtime = createAddonRuntime({ clientIds: ["default"], inboxClients: ["default"], messageInbox: inbox,
      clientFactory: () => client, logger: { error: (...args) => logs.push(args) },
      setTimeoutFn: () => ({ unref() {} }), clearTimeoutFn: () => {},
      httpClient: { post: async (url, body) => posts.push({ url, body }) } });
    client.emit("msg", message("fallback")); await runtime.stopInbox();
    assert.deepEqual(posts, [{ url: "http://supervisor/core/api/events/new_whatsapp_message", body: { clientId: "default", ...message("fallback") } }]);
    assert.equal(inbox.state.pending.length, 1); assert.equal(logs.length, 1);
    assert.ok(!JSON.stringify(logs).includes("Fictional private"));
  });
}

test("startup loads the inbox and shutdown settles delivery before closing storage", async (t) => {
  const { directory } = await fixture(t); const client = new EventEmitter();
  client.disconnect = async () => { client.emit("msg", message("during-shutdown")); await new Promise((resolve) => setImmediate(resolve)); };
  const runtime = await startAddon({ dataRoot: directory, logger: {},
    optionsLoader: async () => ({ clientIds: ["default"], inboxClients: ["default"] }),
    apiTokenLoader: async () => "fictional-token", diagnosticsFactory: () => ({}),
    replayHealthDiagnosticsFn: async () => null, readRecoveryRecordFn: async () => null,
    listenFn: async () => ({}), closeServerFn: async () => {}, clientFactory: () => client,
    httpClient: { post: async () => {} },
  });
  client.emit("msg", message());
  await runtime.close();
  const restarted = await new MessageInbox({ directory: path.join(directory, "inbox") }).start();
  assert.deepEqual(restarted.state.pending.map((entry) => entry.payload.key.id), ["fictional-id", "during-shutdown"]);
});

test("shutdown during media preparation retains the message and stops retry timers", async (t) => {
  const { inbox } = await fixture(t); await inbox.enqueue("default", message());
  const timers = []; let release; let posts = 0;
  const client = new EventEmitter(); client.status = { connected: true };
  const runtime = createAddonRuntime({ clientIds: ["default"], inboxClients: ["default"], messageInbox: inbox,
    clientFactory: () => client, logger: {},
    setTimeoutFn: (fn) => { const timer = { fn, unref() {} }; timers.push(timer); return timer; }, clearTimeoutFn: () => {},
    httpClient: { get: async () => ({ data: { ready: true } }), post: async () => { posts++; } },
    mediaStore: { enrich: () => new Promise((resolve) => { release = resolve; }) } });
  const attempt = timers.shift().fn(); await new Promise((resolve) => setImmediate(resolve));
  const stopping = runtime.stopInbox(); release({ status: "error", error: "stopped" });
  await Promise.all([attempt, stopping]);
  assert.equal(posts, 0); assert.equal(inbox.state.pending.length, 1); assert.equal(timers.length, 0);
});
