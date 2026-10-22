const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const { MessageInbox } = require("../message-inbox");
const { MediaStore } = require("../media-store");
const { createApiApp } = require("../api");

const SESSION = "a".repeat(32);
const UUID = "1bcdfb31-7cd3-47df-8595-17fcaf84943a";
const payload = (id) => ({ key: { id, remoteJid: "12025550123@s.whatsapp.net", fromMe: false },
  message: { conversation: `Fictional message ${id}` }, type: "conversation" });

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-recovery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const create = () => new MessageInbox({ directory, clientIds: ["default", "other"], ...options });
  const inbox = await create().start();
  await inbox.open(SESSION);
  return { directory, create, inbox };
}

async function add(inbox, id, ready = true, client = "default", media) {
  const entryId = await inbox.enqueue(client, payload(id));
  if (ready) await inbox.ready(entryId, media);
  return entryId;
}

test("an old ready backlog survives a routine reconnect and never becomes failed preparation", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now });
  for (let i = 0; i < 4; i++) await add(inbox, `ready-${i}`);
  now += 20 * 60000;
  const offline = await inbox.poll(SESSION, undefined, () => false);
  assert.deepEqual(offline.attention, []);
  now += 6 * 3600000;
  assert.deepEqual((await inbox.poll(SESSION, undefined, () => false)).attention, []);
  const connected = await inbox.poll(SESSION);
  assert.equal(connected.status, "pending");
  assert.equal(connected.message.key.id, "ready-0");
  assert.deepEqual(connected.attention, []);
});

test("preparation timeout starts at an eligible head, excluding time behind another workflow", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now });
  await add(inbox, "first");
  await add(inbox, "waiting", false);
  const first = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(first);
  now += 20 * 60000;
  assert.deepEqual((await inbox.poll(SESSION)).attention, []);
  await inbox.complete(first);
  assert.equal((await inbox.poll(SESSION)).status, "preparing");
  now += 15 * 60000 + 1;
  assert.equal((await inbox.poll(SESSION)).attention[0].reason, "preparation_timeout");
});

test("disconnect pauses an actual preparation wait and refreshes an unclaimed delivery receipt", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now });
  await add(inbox, "first");
  const old = (await inbox.poll(SESSION)).message.inbox;
  now += 20 * 60000;
  assert.deepEqual((await inbox.poll(SESSION, undefined, () => false)).attention, []);
  const resumed = await inbox.poll(SESSION);
  assert.equal(resumed.status, "pending");
  assert.notEqual(resumed.message.inbox.receipt, old.receipt);
  await assert.rejects(inbox.begin(old), { code: "inbox_message_not_found" });
});

test("a normal app restart resumes every unprepared entry", async (t) => {
  const { inbox, create } = await fixture(t);
  for (let i = 0; i < 3; i++) await add(inbox, `unready-${i}`, false);
  const restarted = await create().start(); await restarted.open(SESSION);
  assert.equal(restarted.unready("default").length, 3);
  assert.deepEqual((await restarted.poll(SESSION)).attention, []);
});

test("a pending offer survives an app outage longer than its claim deadline in the same HA session", async (t) => {
  let now = 1000;
  const { inbox, create } = await fixture(t, { now: () => now });
  await add(inbox, "offered");
  const original = (await inbox.poll(SESSION)).message.inbox;
  now += 90000;
  const restarted = await create().start();
  const recovered = await restarted.poll(SESSION);
  assert.equal(recovered.status, "pending");
  assert.notEqual(recovered.message.inbox.receipt, original.receipt);
  assert.equal(recovered.message.inbox.received_at, original.received_at);
});

test("corrupt inbox state only pins UUIDs found in recoverable data", async (t) => {
  const { inbox, create } = await fixture(t);
  await fs.writeFile(inbox.file, `{"broken":"${UUID}`);
  const broken = create();
  await assert.rejects(broken.start(), { code: "inbox_storage_unavailable" });
  assert.equal(broken.isMediaPinned(UUID), true);
  assert.equal(broken.isMediaPinned("1bcdfb31-7cd3-47df-8595-17fcaf84943b"), false);
});

test("corrupt private state does not prevent unrelated legacy media from expiring", async (t) => {
  const { inbox, create, directory } = await fixture(t);
  const root = path.join(directory, "media"); let now = Date.now();
  const broken = create();
  const data = Buffer.from("Fictional media during corrupt inbox recovery");
  const store = await new MediaStore({ root, enabled: true, retentionMs: 1000, now: () => now,
    logger: {}, isPinned: (id) => broken.isMediaPinned(id) }).start();
  t.after(() => store.close());
  const client = { getMediaContent: () => ({ mimetype: "audio/ogg", fileSha256: crypto.createHash("sha256").update(data).digest() }),
    downloadMedia: async () => Readable.from([data]) };
  const protectedMedia = await store.enrich(payload("protected"), client);
  const unrelated = await store.enrich(payload("legacy"), client);
  await fs.writeFile(inbox.file, `{"broken":"${protectedMedia.id}`);
  await assert.rejects(broken.start());
  now += 1001; await store.cleanup();
  assert.equal(store.entries.has(protectedMedia.id), true);
  assert.equal(store.entries.has(unrelated.id), false);
  assert.equal(store.usedBytes, data.length);
  await broken.recover("reset"); await store.cleanup();
  assert.equal(store.usedBytes, 0);
});

test("Home Assistant can recover unreadable state while preserving a private archive", async (t) => {
  const { inbox, create, directory } = await fixture(t);
  await fs.writeFile(inbox.file, "{bad json");
  const broken = create(); await assert.rejects(broken.start());
  await assert.rejects(broken.recover("reload"));
  const recovered = await broken.recover("reset");
  assert.equal(recovered.status, "ready");
  assert.ok(recovered.archive.startsWith("messages.invalid-"));
  assert.equal(await fs.readFile(path.join(directory, recovered.archive), "utf8"), "{bad json");
  await broken.open(SESSION); await add(broken, "new");
  assert.equal((await broken.poll(SESSION)).status, "pending");
});

test("startup syncs the directory parent and removes only unpublished private snapshots", async (t) => {
  const { directory, create } = await fixture(t);
  const temporary = path.join(directory, `.pending-${crypto.randomUUID()}`);
  const unrelated = path.join(directory, ".pending-unrelated");
  const archive = path.join(directory, `messages.invalid-${crypto.randomUUID()}.json`);
  await fs.writeFile(temporary, "Fictional uncommitted state");
  await fs.writeFile(unrelated, "Keep unrelated data");
  await fs.writeFile(archive, "Keep recovery archive");
  const inbox = create(); const sync = inbox.syncDirectory.bind(inbox); const synced = [];
  inbox.syncDirectory = async (target = directory) => { synced.push(target); return sync(target); };
  await inbox.start();
  assert.equal(synced[0], path.dirname(directory));
  assert.ok(synced.includes(directory));
  await assert.rejects(fs.stat(temporary), { code: "ENOENT" });
  assert.equal(await fs.readFile(unrelated, "utf8"), "Keep unrelated data");
  assert.equal(await fs.readFile(archive, "utf8"), "Keep recovery archive");
});

test("bulk resolution frees a held backlog and its media without touching active work", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now, claimTimeoutMs: 10, maxPending: 3 });
  for (let i = 0; i < 3; i++) await add(inbox, `held-${i}`, true, "default", { status: "ready", id: UUID });
  for (let i = 0; i < 3; i++) { await inbox.poll(SESSION); now += 11; }
  await inbox.poll(SESSION);
  assert.equal(inbox.isMediaPinned(UUID), true);
  await assert.rejects(add(inbox, "full"), { code: "inbox_full" });
  const result = await inbox.resolveMany({ session: SESSION, reason: "unclaimed", resolution: "discard" });
  assert.equal(result.resolved, 3);
  assert.equal(inbox.isMediaPinned(UUID), false);
  await add(inbox, "active");
  const active = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(active);
  assert.equal((await inbox.resolveMany({ session: SESSION, clientId: "default", resolution: "discard" })).resolved, 0);
  assert.equal((await inbox.poll(SESSION)).status, "processing");
});

test("a published attachment remains accounted and usable after root directory fsync fails", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-media-published-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.now(); const data = Buffer.from("Fictional published attachment");
  const store = await new MediaStore({ root, enabled: true, retentionMs: 1000, now: () => now, logger: {} }).start();
  t.after(() => store.close());
  const sync = store.syncDirectory.bind(store);
  store.syncDirectory = async (directory) => {
    if (directory === root) throw Object.assign(new Error("Fictional I/O failure"), { code: "EIO" });
    return sync(directory);
  };
  const result = await store.enrich(payload("media"), {
    getMediaContent: () => ({ mimetype: "audio/ogg", fileSha256: crypto.createHash("sha256").update(data).digest() }),
    downloadMedia: async () => Readable.from([data]),
  });
  assert.equal(result.status, "ready");
  assert.equal(store.entries.size, 1);
  assert.equal(store.usedBytes, data.length);
  assert.deepEqual(await fs.readFile(result.local_path), data);
  now += 1001; await store.cleanup();
  assert.equal(store.entries.size, 0);
  assert.equal(store.usedBytes, 0);
});

for (const failure of ["guard_open", "guard_sync", "guard_directory", "snapshot_write", "snapshot_sync",
  "rename_before", "rename_after", "snapshot_directory", "guard_unlink", "guard_removal_directory"]) {
  test(`admission crash boundary ${failure} preserves prior work and isolates only an uncertain new entry`, async (t) => {
    const { inbox, create, directory } = await fixture(t);
    for (let i = 0; i < 3; i++) await add(inbox, `safe-${i}`, false);
    const realSync = inbox.syncDirectory.bind(inbox); let directorySyncs = 0;
    inbox.syncDirectory = async () => {
      directorySyncs++;
      if ((failure === "guard_directory" && directorySyncs === 1) ||
          (failure === "snapshot_directory" && directorySyncs === 2) ||
          (failure === "guard_removal_directory" && directorySyncs === 3)) throw new Error("Fictional fsync failure");
      return realSync();
    };
    inbox.fsPromises = {
      ...fs,
      open: async (file, flags, mode) => {
        const guard = path.basename(file).startsWith(".admission-");
        const snapshot = path.basename(file).startsWith(".pending-");
        if (guard && failure === "guard_open") throw new Error("Fictional guard open failure");
        const handle = await fs.open(file, flags, mode);
        return {
          writeFile: async (...args) => {
            if (snapshot && failure === "snapshot_write") throw new Error("Fictional snapshot write failure");
            return handle.writeFile(...args);
          },
          sync: async () => {
            if ((guard && failure === "guard_sync") || (snapshot && failure === "snapshot_sync")) throw new Error("Fictional file sync failure");
            return handle.sync();
          },
          close: () => handle.close(),
        };
      },
      rename: async (...args) => {
        if (failure === "rename_before") throw new Error("Fictional rename failure");
        await fs.rename(...args);
        if (failure === "rename_after") throw new Error("Fictional uncertain rename result");
      },
      unlink: async (file) => {
        if (path.basename(file).startsWith(".admission-") && failure === "guard_unlink") throw new Error("Fictional guard unlink failure");
        return fs.unlink(file);
      },
    };
    let rejected = false;
    try { await add(inbox, "uncertain", false); } catch (error) {
      rejected = true; assert.equal(error.code, "inbox_storage_unavailable");
    }
    assert.equal(rejected, !["guard_unlink", "guard_removal_directory"].includes(failure));
    const recovered = await create().start(); await recovered.open(SESSION);
    const safe = recovered.state.entries.filter((entry) => entry.messageId?.startsWith("safe-"));
    assert.equal(safe.length, 3);
    assert.ok(safe.every((entry) => entry.status === "pending" && !entry.ready));
    const uncertain = recovered.state.entries.find((entry) => entry.messageId === "uncertain");
    if (["rename_after", "snapshot_directory", "guard_unlink"].includes(failure)) {
      assert.equal(uncertain.status, "blocked");
      assert.equal(uncertain.reason, "preparation_interrupted");
    } else if (failure === "guard_removal_directory") assert.equal(uncertain.status, "pending");
    else assert.equal(uncertain, undefined);
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.startsWith(".admission-")), []);
  });
}

test("recovery of a healthy inbox cannot interrupt an active workflow or erase its state", async (t) => {
  const { inbox } = await fixture(t);
  await add(inbox, "active");
  const reference = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(reference);
  const before = JSON.stringify(inbox.state);
  await inbox.recover("reload"); await inbox.recover("reset");
  assert.equal(JSON.stringify(inbox.state), before);
  await inbox.complete(reference);
});

test("reset will not archive a valid snapshot during a transient read failure", async (t) => {
  const { inbox, create, directory } = await fixture(t);
  await add(inbox, "kept", false);
  const broken = create();
  broken.fsPromises = { ...fs, open: async () => { throw Object.assign(new Error("Fictional read failure"), { code: "EIO" }); } };
  await assert.rejects(broken.start());
  await assert.rejects(broken.recover("reset"));
  assert.ok(!(await fs.readdir(directory)).some((name) => name.startsWith("messages.invalid-")));
  broken.fsPromises = fs;
  await broken.recover("reload");
  assert.equal(broken.unready("default").length, 1);
});

test("bulk filters are session guarded, require scope, and never mutate unrelated held or pending items", async (t) => {
  const { inbox } = await fixture(t);
  await add(inbox, "a", true, "default");
  const a = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(a); await inbox.resolve(a, "hold");
  await add(inbox, "b", true, "other");
  const b = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(b); await inbox.resolve(b, "hold");
  await add(inbox, "pending", true, "default");
  assert.throws(() => inbox.resolveMany({ session: SESSION, resolution: "discard" }), { code: "invalid_inbox_filter" });
  await assert.rejects(inbox.resolveMany({ session: "b".repeat(32), reason: "workflow_failed", resolution: "discard" }), { code: "inbox_session_changed" });
  assert.equal((await inbox.resolveMany({ session: SESSION, clientId: "default", reason: "workflow_failed", resolution: "retry" })).resolved, 1);
  const result = await inbox.poll(SESSION);
  assert.equal(result.attention.length, 1);
  assert.equal(result.attention[0].clientId, "other");
  assert.equal(result.message.key.id, "a");
  assert.notEqual(result.message.inbox.receipt, a.receipt);
  assert.equal(inbox.state.entries.find((entry) => entry.messageId === "pending").status, "pending");
});

test("disabled accounts remain visible for bulk discard and cannot be retried", async (t) => {
  const { inbox, directory } = await fixture(t);
  await add(inbox, "disabled", true, "other", { status: "ready", id: UUID });
  const changed = await new MessageInbox({ directory, clientIds: ["default"] }).start(); await changed.open(SESSION);
  const result = await changed.poll(SESSION);
  assert.equal(result.attention[0].reason, "account_disabled");
  assert.equal(changed.unready("other").length, 0);
  await assert.rejects(changed.resolveMany({ session: SESSION, reason: "account_disabled", resolution: "retry" }), { code: "inbox_disabled" });
  assert.equal((await changed.resolveMany({ session: SESSION, reason: "account_disabled", resolution: "discard" })).resolved, 1);
  assert.equal(changed.isMediaPinned(UUID), false);
  assert.equal((await changed.poll(SESSION)).status, "empty");
});

for (const seed of [7, 39, 173, 991]) {
  test(`stateful delivery audit seed ${seed}: restarts, reconnects, manual recovery and claims`, async (t) => {
    let now = 1000; let randomState = seed;
    const random = (max) => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return Math.floor(randomState / 2 ** 32 * max); };
    const { create, inbox: first } = await fixture(t, { now: () => now, maxPending: 24 });
    let inbox = first; let session = SESSION; let sequence = 0;
    const connected = { default: true, other: true };
    const originals = new Map(); const claimed = new Set(); const mustNotRun = new Set(); const mediaIds = new Set();
    const operations = new Set();
    for (let step = 0; step < 280; step++) {
      const op = random(9);
      operations.add(op);
      if (op === 0 || inbox.state.entries.length === 0) {
        const id = `seed-${seed}-${++sequence}`; const client = random(2) ? "default" : "other";
        try {
          const receiptId = await inbox.enqueue(client, payload(id));
          originals.set(receiptId, { id, client, receivedAt: now });
        } catch (error) { assert.equal(error.code, "inbox_full"); }
      } else if (op === 1) {
        const candidates = inbox.state.entries.filter((entry) => entry.status === "pending" && !entry.ready);
        const entry = candidates[random(candidates.length)];
        if (entry) {
          const media = random(3) === 0 ? { status: "ready", id: crypto.randomUUID() } : undefined;
          if (media) mediaIds.add(media.id);
          await inbox.ready(entry.id, media);
        }
      } else if (op === 2) {
        const result = await inbox.poll(session, async (media) => media, (client) => connected[client]);
        for (const item of result.attention) {
          if (item.reason === "preparation_timeout") assert.equal(inbox.state.entries.find((entry) => entry.id === item.inbox.id).ready, false);
        }
        if (result.status === "pending" && random(2)) {
          const reference = result.message.inbox; const original = originals.get(reference.id);
          assert.equal(result.message.key.id, original.id);
          assert.equal(result.message.clientId, original.client);
          assert.equal(reference.received_at, new Date(original.receivedAt).toISOString());
          assert.ok(!mustNotRun.has(reference.id), "started work was replayed without an explicit retry");
          const started = await inbox.begin(reference);
          assert.equal(started.started, true);
          const token = reference.id + reference.receipt;
          assert.ok(!claimed.has(token), "one receipt executed twice"); claimed.add(token); mustNotRun.add(reference.id);
          assert.equal((await inbox.begin(reference)).started, false);
        }
      } else if (op === 3) {
        const processing = inbox.state.entries.filter((entry) => entry.status === "processing");
        const entry = processing[random(processing.length)];
        if (entry) await inbox.complete(inbox.envelope(entry, session));
      } else if (op === 4) {
        const before = inbox.state.entries.filter((entry) => entry.status === "pending").map((entry) => entry.id);
        await inbox.close(); inbox = await create().start();
        for (const id of before) assert.equal(inbox.state.entries.find((entry) => entry.id === id).status, "pending", "normal restart held unstarted work");
      } else if (op === 5) {
        session = crypto.randomBytes(16).toString("hex"); await inbox.open(session);
      } else if (op === 6) {
        const selected = inbox.state.entries.filter((entry) => ["blocked", "interrupted"].includes(entry.status));
        const client = random(2) ? "default" : "other"; const resolution = random(2) ? "retry" : "discard";
        const active = inbox.state.entries.filter((entry) => ["pending", "processing"].includes(entry.status)).map((entry) => [entry.id, entry.status, entry.receipt]);
        await inbox.resolveMany({ session, clientId: client, resolution });
        if (resolution === "retry") for (const entry of selected) if (entry.clientId === client) mustNotRun.delete(entry.id);
        for (const [id, status, receipt] of active) {
          const entry = inbox.state.entries.find((item) => item.id === id);
          assert.equal(entry.status, status); assert.equal(entry.receipt, receipt);
        }
      } else if (op === 7) {
        const client = random(2) ? "default" : "other"; connected[client] = !connected[client];
      } else now += random(6) * 60000;

      const unfinished = inbox.state.entries.filter((entry) => entry.status !== "completed");
      assert.ok(unfinished.length <= 24);
      assert.equal(new Set(inbox.state.entries.map((entry) => entry.id)).size, inbox.state.entries.length);
      for (const client of ["default", "other"]) {
        assert.ok(unfinished.filter((entry) => entry.clientId === client && entry.status === "processing").length <= 1);
      }
      for (const id of mediaIds) assert.equal(inbox.isMediaPinned(id), unfinished.some((entry) => entry.payload?.media?.id === id));
      for (const entry of inbox.state.entries.filter((item) => item.status === "completed")) assert.equal(entry.payload, undefined);
      assert.equal(JSON.stringify(inbox.state), JSON.stringify(JSON.parse(await fs.readFile(inbox.file, "utf8"))));
    }
    assert.equal(operations.size, 9);
    assert.ok(claimed.size >= 2, "audit must execute real claims as well as inspect state");
    assert.ok(sequence >= 10, "audit must admit a meaningful backlog");
  });
}

test("authenticated HTTP recovery and bulk resolution work without an app restart", async (t) => {
  const { inbox, directory } = await fixture(t);
  await fs.writeFile(inbox.file, "Fictional invalid private snapshot");
  const broken = new MessageInbox({ directory, clientIds: ["default"] });
  await assert.rejects(broken.start());
  const app = createApiApp({ clients: { default: { status: { connected: true } } },
    sharedSecret: "fictional-api-token", logger: {}, messageInbox: broken });
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (operation, body, auth = true) => {
    const response = await fetch(`${base}/inbox/${operation}`, { method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer fictional-api-token" } : {}) },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  for (const operation of ["recover", "resolve_many"]) {
    assert.equal((await post(operation, { mode: "reset", session: SESSION, reason: "unclaimed", resolution: "discard" }, false)).status, 401);
  }
  assert.equal(await fs.readFile(broken.file, "utf8"), "Fictional invalid private snapshot");
  assert.equal((await post("recover", { mode: "unknown" })).status, 400);
  assert.equal((await post("recover", { mode: "reload" })).status, 503);
  const recovered = await post("recover", { mode: "reset" });
  assert.equal(recovered.status, 200); assert.equal(recovered.body.status, "ready");
  assert.equal(await fs.readFile(path.join(directory, recovered.body.archive), "utf8"), "Fictional invalid private snapshot");
  assert.equal((await post("open", { session: SESSION })).status, 200);
  await add(broken, "held");
  const reference = (await post("poll", { session: SESSION })).body.message.inbox;
  assert.equal((await post("start", { inbox: reference })).body.started, true);
  assert.equal((await post("resolve", { inbox: reference, resolution: "hold" })).status, 200);
  await add(broken, "ordinary-pending");
  assert.equal((await post("resolve_many", { session: SESSION, resolution: "discard" })).status, 400);
  assert.equal((await post("resolve_many", { session: "b".repeat(32), reason: "workflow_failed", resolution: "discard" })).status, 409);
  assert.equal((await post("resolve_many", { session: SESSION, reason: "workflow_failed", resolution: "discard" })).body.resolved, 1);
  assert.equal((await post("poll", { session: SESSION })).body.message.key.id, "ordinary-pending");
});
