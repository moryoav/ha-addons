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

/** Model cancellable timers without waiting for the ten-second network backoff. */
function fakeTimers() {
  const timers = [];
  return { timers,
    /** Schedule one callback until the test advances it. */
    setTimeoutFn(fn, delay) { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    /** Remove a callback exactly as the runtime's clearTimeout would. */
    clearTimeoutFn(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  };
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

test("invalid snapshots are archived privately and recovery resumes automatically", async (t) => {
  const { inbox, create } = await fixture(t);
  for (const raw of ['{"version":', '{"version":1,"pending":[null],"delivered":[]}', '{"version":2,"pending":[],"delivered":[]}']) {
    await fs.writeFile(inbox.file, raw);
    const broken = create();
    await broken.start();
    assert.equal(broken.failed, false);
    assert.equal(broken.state.pending.length, 0);
    const archives = (await fs.readdir(inbox.directory)).filter((name) => name.startsWith("messages.invalid-"));
    assert.ok((await Promise.all(archives.map((name) => fs.readFile(path.join(inbox.directory, name), "utf8")))).includes(raw));
  }
  const limited = new MessageInbox({ directory: inbox.directory, maxBytes: 2,
    fsPromises: { ...fs, readFile: async () => { assert.fail("Oversized state must not be read"); } } });
  await assert.rejects(limited.start());
});

test("corrupt rows are archived without dropping valid messages or changing stored receipt IDs", async (t) => {
  const { inbox, create, directory } = await fixture(t);
  await inbox.enqueue("default", message()); await inbox.enqueue("default", message("second"));
  const saved = JSON.parse(await fs.readFile(inbox.file, "utf8"));
  saved.pending[0].id = "f".repeat(64); // A prior release can have used a different hash.
  saved.pending.splice(1, 0, null); saved.delivered.push({ id: "bad", at: 1 });
  const raw = JSON.stringify(saved); await fs.writeFile(inbox.file, raw);
  const restored = await create().start();
  assert.deepEqual(restored.state.pending.map((entry) => entry.payload.key.id), ["fictional-id", "second"]);
  assert.equal(restored.state.pending[0].id, "f".repeat(64));
  const archive = (await fs.readdir(directory)).find((name) => name.startsWith("messages.invalid-"));
  assert.equal(await fs.readFile(path.join(directory, archive), "utf8"), raw);
  assert.equal((await create().start()).state.pending.length, 2);
});

test("read or archive failures never replace the original snapshot, and retry needs no restart", async (t) => {
  const { inbox, create, directory } = await fixture(t); await inbox.enqueue("default", message());
  const original = await fs.readFile(inbox.file, "utf8"); const broken = create();
  broken.fsPromises = { ...fs, readFile: async () => { throw new Error("Fictional read failure"); } };
  await assert.rejects(broken.start());
  assert.equal((await fs.readdir(directory)).filter((name) => name.startsWith("messages.invalid-")).length, 0);
  assert.equal(await fs.readFile(inbox.file, "utf8"), original);
  await fs.writeFile(inbox.file, "Fictional corrupt snapshot");
  broken.fsPromises = { ...fs, copyFile: async () => { throw new Error("Fictional archive failure"); } };
  await assert.rejects(broken.start());
  assert.equal(await fs.readFile(inbox.file, "utf8"), "Fictional corrupt snapshot");
  broken.fsPromises = fs; await broken.start(); await broken.enqueue("default", message("recovered"));
  assert.equal(broken.peek(() => true).payload.key.id, "recovered");
});

test("one-shot write failures recover both before and after atomic replacement", async (t) => {
  const { inbox } = await fixture(t); await inbox.enqueue("default", message());
  let fail = true;
  inbox.fsPromises = { ...fs, rename: async (...args) => {
    if (fail) { fail = false; throw new Error("Fictional pre-publication failure"); }
    return fs.rename(...args);
  } };
  await inbox.enqueue("default", message("second"));
  const sync = inbox.syncDirectory.bind(inbox); fail = true;
  inbox.syncDirectory = async (...args) => {
    if (fail) { fail = false; throw new Error("Fictional post-publication failure"); }
    return sync(...args);
  };
  await inbox.enqueue("default", message("third"));
  assert.equal(inbox.failed, false);
  assert.deepEqual(inbox.state.pending.map((entry) => entry.payload.key.id), ["fictional-id", "second", "third"]);
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
    const syncDirectory = Object.getPrototypeOf(inbox).syncDirectory.bind(inbox);
    await assert.rejects(inbox.enqueue("default", message("second")), /could not be (saved|loaded)/);
    const uncertain = await fs.readFile(inbox.file, "utf8");
    if (stage !== "directory") assert.equal(uncertain, previous);
    await assert.rejects(inbox.enqueue("default", message("third")), /could not be (saved|loaded)/);
    assert.equal(await fs.readFile(inbox.file, "utf8"), uncertain);
    const restarted = await create().start();
    assert.equal(restarted.peek(() => true).payload.key.id, "fictional-id");
    inbox.fsPromises = fs; inbox.syncDirectory = syncDirectory;
    await inbox.enqueue("default", message("after-recovery"));
    assert.equal(inbox.failed, false);
    assert.equal(inbox.state.pending.at(-1).payload.key.id, "after-recovery");
    if (stage === "directory") assert.equal(inbox.state.pending[1].payload.key.id, "second");
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
  const { inbox, create, directory } = await fixture(t); const clock = fakeTimers(); const { timers } = clock; const posts = []; const logs = [];
  let reachable = false; let accept = false; let downloads = 0;
  const media = { status: "ready", id: "fictional-media", size: 5,
    local_path: path.join(directory, "cached-audio"), expires_at: "2099-01-01T00:00:00Z" };
  const client = new EventEmitter(); client.status = { connected: true };
  const runtime = createAddonRuntime({ clientIds: ["default"], inboxClients: ["default"], messageInbox: inbox,
    clientFactory: () => client, logger: { error: (...args) => logs.push(args) },
    ...clock,
    mediaStore: { enrich: async () => { downloads++; await fs.writeFile(media.local_path, "audio"); return media; } },
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
  await timers.shift().fn(); assert.equal(downloads, 1);
  await fs.unlink(media.local_path); await timers.shift().fn(); assert.equal(downloads, 2);
  accept = true; await timers.shift().fn();
  assert.equal(inbox.state.pending.length, 0);
  assert.equal(posts.length, 4); assert.equal(posts[0].body.id, posts[1].body.id);
  assert.equal(posts[1].url, "http://supervisor/core/api/whatsapp/inbox");
  assert.deepEqual(posts[1].body.message, { ...message(), media, clientId: "default" });
  assert.equal(posts[1].options.timeout, 10000);
  assert.ok(!JSON.stringify(logs).includes("Private response"));
});

test("backlogs drain promptly while disconnected media preserves account order", async (t) => {
  const { inbox } = await fixture(t); const clock = fakeTimers(); const { timers } = clock; const posts = []; const live = [];
  await inbox.enqueue("offline", { ...message("first"), type: "audioMessage", message: { audioMessage: { ptt: false } } });
  await inbox.enqueue("offline", message("after-media"));
  await inbox.enqueue("default", message("second")); await inbox.enqueue("default", message("third"));
  const clients = {};
  const runtime = createAddonRuntime({ clientIds: ["offline", "default", "live"], inboxClients: ["offline", "default"], messageInbox: inbox, logger: {},
    clientFactory: ({ path: sessionPath }) => { const client = new EventEmitter(); client.status = { connected: path.basename(sessionPath) === "default" }; client.getMediaContent = (payload) => payload.message.audioMessage; clients[path.basename(sessionPath)] = client; return client; },
    ...clock, mediaStore: { enrich: async () => undefined },
    httpClient: { get: async () => ({ data: { ready: true } }), post: async (url, body) => (url.endsWith("/events/new_whatsapp_message") ? live : posts).push(body) } });
  t.after(() => runtime.stopInbox());
  clients.live.emit("msg", message("live")); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(live, [{ clientId: "live", ...message("live") }]);
  await timers.shift().fn(); assert.equal(posts.length, 1); assert.equal(posts[0].message.key.id, "second");
  assert.equal(timers[0].delay, 0); await timers.shift().fn();
  assert.equal(posts[1].message.key.id, "third");
  clients.offline.status.connected = true; await timers.shift().fn();
  assert.equal(posts[2].message.key.id, "first");
  await timers.shift().fn(); assert.equal(posts[3].message.key.id, "after-media");
  assert.equal(inbox.state.pending.length, 0);
});

test("idle delivery wakes immediately, drains a burst without backoff and never overlaps requests", async (t) => {
  const { inbox } = await fixture(t); const clock = fakeTimers(); const { timers } = clock;
  const client = new EventEmitter(); client.status = { connected: false };
  const posts = []; let release; let active = 0;
  const runtime = createAddonRuntime({ clientIds: ["default"], inboxClients: ["default"], messageInbox: inbox,
    clientFactory: () => client, logger: {}, ...clock,
    httpClient: { get: async () => ({ data: { ready: true } }), post: async (_, body) => {
      assert.equal(++active, 1); posts.push(body);
      if (posts.length === 1) await new Promise((resolve) => { release = resolve; });
      active--;
    } } });
  t.after(() => runtime.stopInbox());
  await timers.shift().fn(); assert.equal(timers.length, 0);
  client.emit("msg", message("first")); await new Promise((resolve) => setImmediate(resolve)); await inbox.close();
  assert.equal(timers[0].delay, 0); const first = timers.shift().fn();
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 2; index <= 5; index++) client.emit("msg", message(`message-${index}`));
  await new Promise((resolve) => setImmediate(resolve)); await inbox.close();
  assert.equal(timers.length, 0); release(); await first;
  while (timers.length) { assert.equal(timers[0].delay, 0); await timers.shift().fn(); }
  assert.equal(posts.length, 5); assert.equal(inbox.state.pending.length, 0);
});

test("a failed queue reloads and resumes delivery on the next tick without a new message", async (t) => {
  const { inbox } = await fixture(t); await inbox.enqueue("default", message());
  inbox.failed = true; const clock = fakeTimers(); const client = new EventEmitter(); const posts = [];
  const runtime = createAddonRuntime({ clientIds: ["default"], inboxClients: ["default"], messageInbox: inbox,
    clientFactory: () => client, logger: {}, ...clock,
    httpClient: { get: async () => ({ data: { ready: true } }), post: async (_, body) => posts.push(body) } });
  t.after(() => runtime.stopInbox());
  await clock.timers.shift().fn();
  assert.equal(inbox.failed, false); assert.equal(posts.length, 1); assert.equal(inbox.state.pending.length, 0);
});

test("cached media near expiry is replaced and an app restart uses a fresh download", async (t) => {
  const { inbox, create, directory } = await fixture(t); await inbox.enqueue("default", message());
  let now = Date.now(); let downloads = 0;
  t.mock.method(Date, "now", () => now);
  const clock = fakeTimers(); const client = new EventEmitter();
  const mediaStore = { enrich: async () => {
    const media = { status: "ready", id: `media-${++downloads}`, size: 5,
      local_path: path.join(directory, `audio-${downloads}`), expires_at: new Date(now + 3600000).toISOString() };
    await fs.writeFile(media.local_path, "audio"); return media;
  } };
  const options = { clientIds: ["default"], inboxClients: ["default"], clientFactory: () => client,
    logger: {}, mediaStore, httpClient: { get: async () => ({ data: { ready: true } }), post: async () => { throw new Error("Fictional transport failure"); } } };
  const runtime = createAddonRuntime({ ...options, ...clock, messageInbox: inbox });
  await clock.timers.shift().fn(); assert.equal(downloads, 1);
  now += 3590000; await clock.timers.shift().fn(); assert.equal(downloads, 2);
  await runtime.stopInbox();
  const secondClock = fakeTimers(); const restarted = createAddonRuntime({ ...options, ...secondClock, messageInbox: await create().start() });
  await secondClock.timers.shift().fn(); assert.equal(downloads, 3);
  await restarted.stopInbox();
});

for (const unavailable of [false, true]) {
  test(`storage ${unavailable ? "failure" : "capacity"} preserves the backlog and falls back to live delivery`, async (t) => {
    const { inbox } = await fixture(t, { maxPending: 1 }); await inbox.enqueue("default", message());
    inbox.failed = unavailable;
    if (unavailable) inbox.fsPromises = { ...fs, readFile: async () => { throw new Error("Fictional read failure"); } };
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
