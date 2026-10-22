const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MessageInbox } = require("../message-inbox");
const { createApiApp } = require("../api");

const SESSION = "a".repeat(32);
const OTHER_SESSION = "b".repeat(32);
const message = (id = "fictional-1", chat = "12025550123@s.whatsapp.net") => ({
  key: { id, remoteJid: chat, fromMe: false }, type: "conversation",
  messageTimestamp: 1234567890, message: { conversation: "Fictional private note. שלום." },
});

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-inbox-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const create = () => new MessageInbox({ directory, clientIds: ["default", "other"], ...options });
  const inbox = await create().start();
  await inbox.open(SESSION);
  return { inbox, create, directory };
}

async function enqueue(inbox, payload = message(), client = "default", media) {
  const id = await inbox.enqueue(client, payload);
  if (id) await inbox.ready(id, media);
  return id;
}

test("pending messages survive app restart with original metadata and arrival order", async (t) => {
  const { inbox, create } = await fixture(t);
  const original = message();
  const id = await enqueue(inbox, original);
  await enqueue(inbox, message("fictional-2"), "other");
  const restarted = await create().start(); await restarted.open(OTHER_SESSION);
  const result = await restarted.poll(OTHER_SESSION);
  assert.equal(result.status, "pending");
  assert.deepEqual(result.counts, { pending: 2, processing: 0, interrupted: 0, blocked: 0 });
  assert.equal(result.message.inbox.id, id);
  assert.deepEqual(result.message.key, original.key);
  assert.deepEqual(result.message.message, original.message);
  assert.equal(result.message.clientId, "default");
});

test("a delivery is not processing until the automation explicitly starts it", async (t) => {
  const { inbox, create } = await fixture(t); await enqueue(inbox);
  const first = await inbox.poll(SESSION);
  assert.equal((await inbox.poll(SESSION)).message.inbox.receipt, first.message.inbox.receipt);
  const restarted = await create().start(); await restarted.open(OTHER_SESSION);
  assert.equal((await restarted.poll(OTHER_SESSION)).status, "pending");
});

test("concurrent duplicate starts have exactly one winner", async (t) => {
  const { inbox } = await fixture(t); await enqueue(inbox);
  const { inbox: reference } = (await inbox.poll(SESSION)).message;
  const results = await Promise.all([inbox.begin(reference), inbox.begin(reference)]);
  assert.equal(results.filter((result) => result.started).length, 1);
  assert.equal((await inbox.poll(SESSION)).status, "processing");
  assert.deepEqual(await inbox.complete(reference), { status: "completed" });
  assert.deepEqual(await inbox.complete(reference), { status: "completed" });
  assert.equal((await inbox.poll(SESSION)).status, "empty");
});

test("processing becomes interrupted after either HA session change or app restart", async (t) => {
  for (const restartApp of [false, true]) {
    const { inbox, create } = await fixture(t); await enqueue(inbox);
    await inbox.begin((await inbox.poll(SESSION)).message.inbox);
    const next = restartApp ? await create().start() : inbox;
    await next.open(OTHER_SESSION);
    assert.equal((await next.poll(OTHER_SESSION)).status, "interrupted");
  }
});

test("an interrupted action is retained for review while later messages continue", async (t) => {
  const { inbox } = await fixture(t); await enqueue(inbox); await enqueue(inbox, message("later"));
  const reference = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(reference); await inbox.open(OTHER_SESSION);
  const interrupted = await inbox.poll(OTHER_SESSION);
  assert.equal(interrupted.attention[0].inbox.id, reference.id);
  assert.equal(interrupted.status, "pending");
  await inbox.resolve(interrupted.attention[0].inbox, "discard");
  assert.equal((await inbox.poll(OTHER_SESSION)).message.key.id, "later");
});

test("explicit retry changes the receipt and refuses stale acknowledgements", async (t) => {
  const { inbox } = await fixture(t); await enqueue(inbox);
  const old = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(old); await inbox.open(OTHER_SESSION);
  const reference = (await inbox.poll(OTHER_SESSION)).inbox;
  await inbox.resolve(reference, "retry");
  const retried = (await inbox.poll(OTHER_SESSION)).message.inbox;
  assert.notEqual(retried.receipt, old.receipt);
  await assert.rejects(inbox.complete({ ...old, session: OTHER_SESSION }), { code: "inbox_message_not_found" });
  assert.equal((await inbox.begin(retried)).started, true);
});

test("completed payloads are erased and redelivery remains deduplicated across restart", async (t) => {
  const { inbox, create, directory } = await fixture(t); await enqueue(inbox);
  const reference = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(reference); await inbox.complete(reference);
  assert.ok(!(await fs.readFile(path.join(directory, "messages.json"), "utf8")).includes("Fictional private"));
  const restarted = await create().start();
  assert.equal(await restarted.enqueue("default", message()), null);
});

test("a complete acknowledgement cannot skip the start gate", async (t) => {
  const { inbox } = await fixture(t); await enqueue(inbox);
  await assert.rejects(inbox.complete((await inbox.poll(SESSION)).message.inbox), { code: "inbox_message_not_started" });
});

test("capacity never evicts unfinished messages", async (t) => {
  const { inbox, create } = await fixture(t, { maxPending: 1 });
  await enqueue(inbox);
  await assert.rejects(enqueue(inbox, message("second")), { code: "inbox_full" });
  const restarted = await create().start(); await restarted.open(SESSION);
  assert.equal((await restarted.poll(SESSION)).message.key.id, "fictional-1");
});

test("oversized and invalid messages are refused without exposing their content", async (t) => {
  const { inbox } = await fixture(t, { maxMessageBytes: 400 });
  const oversized = message(); oversized.message.conversation = "private".repeat(200);
  await assert.rejects(inbox.enqueue("default", oversized), { code: "inbox_message_too_large" });
  for (const value of [{}, { ...message(), key: { ...message().key, fromMe: true } }]) {
    await assert.rejects(inbox.enqueue("default", value), { code: "invalid_inbox_message" });
  }
  await assert.rejects(inbox.enqueue("disabled", message()), { code: "inbox_disabled" });
});

test("malformed or truncated storage fails closed without overwriting it", async (t) => {
  const { create, directory } = await fixture(t);
  const file = path.join(directory, "messages.json"); await fs.writeFile(file, '{"version":');
  await assert.rejects(create().start(), { code: "inbox_storage_unavailable" });
  assert.equal(await fs.readFile(file, "utf8"), '{"version":');
});

test("failed atomic publication preserves the previous message and removes temporary files", async (t) => {
  const { inbox, directory } = await fixture(t); await enqueue(inbox);
  const original = await fs.readFile(inbox.file, "utf8");
  inbox.fsPromises = { ...fs, rename: async () => { throw new Error("private filesystem detail"); } };
  await assert.rejects(inbox.enqueue("default", message("second")), { code: "inbox_storage_unavailable" });
  assert.equal(await fs.readFile(inbox.file, "utf8"), original);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.startsWith(".pending-")), []);
});

test("an uncertain directory flush cannot overwrite a published message from stale memory", async (t) => {
  const { inbox, create } = await fixture(t); await enqueue(inbox);
  inbox.syncDirectory = async () => { throw new Error("Fictional directory flush failure"); };
  await assert.rejects(inbox.enqueue("default", message("second")), { code: "inbox_storage_unavailable" });
  const published = await fs.readFile(inbox.file, "utf8");
  assert.ok(published.includes('"messageId":"second"'));
  await assert.rejects(inbox.enqueue("default", message("third")), { code: "inbox_storage_unavailable" });
  assert.equal(await fs.readFile(inbox.file, "utf8"), published);
  const recovered = await create().start();
  assert.equal(recovered.state.entries.length, 2);
});

test("media is pinned before cleanup and unpinned only after completion", async (t) => {
  const { inbox } = await fixture(t);
  const id = "1bcdfb31-7cd3-47df-8595-17fcaf84943a";
  await enqueue(inbox, message(), "default", { id, status: "ready", expires_at: "2000-01-01T00:00:00Z" });
  assert.equal(inbox.isMediaPinned(id), true);
  const renewed = "2099-01-01T00:00:00Z";
  const result = await inbox.poll(SESSION, async (media) => ({ ...media, expires_at: renewed }));
  assert.equal(result.message.media.expires_at, renewed);
  await inbox.begin(result.message.inbox); await inbox.complete(result.message.inbox);
  assert.equal(inbox.isMediaPinned(id), false);
});

test("a transient renewal failure keeps the attachment durable and pinned until retry succeeds", async (t) => {
  const { inbox, create } = await fixture(t);
  const media = { id: "1bcdfb31-7cd3-47df-8595-17fcaf84943a", status: "ready", expires_at: "2000-01-01T00:00:00Z" };
  await enqueue(inbox, message(), "default", media);
  const failed = await inbox.poll(SESSION, async () => ({ status: "error", error: "inbox_media_unavailable" }));
  assert.equal(failed.status, "preparing");
  assert.equal(failed.error, "inbox_media_unavailable");
  assert.equal(failed.message, undefined);
  assert.equal(inbox.isMediaPinned(media.id), true);
  const restarted = await create().start(); await restarted.open(SESSION);
  assert.equal(restarted.isMediaPinned(media.id), true);
  assert.deepEqual(restarted.state.entries[0].payload.media, media);
  const renewed = await restarted.poll(SESSION, async (item) => ({ ...item, expires_at: "2099-01-01T00:00:00Z" }));
  assert.equal(renewed.status, "pending");
  assert.equal(renewed.message.media.id, media.id);
});

test("ready messages wait for the WhatsApp account to reconnect before delivery", async (t) => {
  const { inbox } = await fixture(t); await enqueue(inbox);
  const paused = await inbox.poll(SESSION, undefined, () => false);
  assert.equal(paused.status, "preparing");
  assert.equal(paused.message, undefined);
  assert.equal((await inbox.poll(SESSION, undefined, () => true)).status, "pending");
});

test("incomplete preparation survives restart for review while ready messages continue", async (t) => {
  const { inbox, create } = await fixture(t); await inbox.enqueue("default", message());
  await enqueue(inbox, message("second"));
  const next = await create().start(); await next.open(SESSION);
  assert.equal(next.unready("default").length, 0);
  const result = await next.poll(SESSION);
  assert.equal(result.message.key.id, "second");
  assert.equal(result.attention[0].reason, "preparation_interrupted");
  await next.resolve(result.attention[0].inbox, "retry");
  assert.equal(next.unready("default").length, 1);
});

test("a stale HA session cannot consume or mutate the current inbox", async (t) => {
  const { inbox } = await fixture(t); await enqueue(inbox);
  const reference = (await inbox.poll(SESSION)).message.inbox; await inbox.open(OTHER_SESSION);
  await assert.rejects(inbox.poll(SESSION), { code: "inbox_session_changed" });
  await assert.rejects(inbox.begin(reference), { code: "invalid_inbox_reference" });
});

test("inbox API requires authentication and only explicit requests change processing state", async (t) => {
  const { inbox } = await fixture(t); await enqueue(inbox);
  const app = createApiApp({ clients: { default: { status: { connected: true } } },
    sharedSecret: "fictional-api-token", messageInbox: inbox });
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/inbox/`;
  const post = (operation, body, token = "fictional-api-token") => fetch(url+operation, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  assert.equal((await post("poll", { session: SESSION }, "wrong-token")).status, 401);
  const result = await (await post("poll", { session: SESSION })).json();
  assert.equal(result.status, "pending");
  const reference = result.message.inbox;
  assert.equal((await (await post("start", { inbox: reference })).json()).started, true);
  assert.equal((await (await post("complete", { inbox: reference })).json()).status, "completed");
});

test("offline, unprepared, and processing account heads cannot block another account", async (t) => {
  for (const state of ["offline", "unprepared", "processing", "interrupted"]) {
    const { inbox } = await fixture(t);
    const firstId = await inbox.enqueue("default", message());
    if (state !== "unprepared") await inbox.ready(firstId);
    if (["processing", "interrupted"].includes(state)) {
      await inbox.begin((await inbox.poll(SESSION)).message.inbox);
      if (state === "interrupted") { await inbox.open(OTHER_SESSION); await inbox.open(SESSION); }
    }
    await enqueue(inbox, message("other-account"), "other");
    const result = await inbox.poll(SESSION, undefined, (id) => state !== "offline" || id !== "default");
    assert.equal(result.message.clientId, "other", state);
    assert.equal((await inbox.begin(result.message.inbox)).started, true, state);
  }
});

test("unclaimed messages time out durably and do not hold later messages hostage", async (t) => {
  let now = 1000;
  const { inbox, create } = await fixture(t, { now: () => now, claimTimeoutMs: 60 });
  await enqueue(inbox); await enqueue(inbox, message("later"));
  const original = (await inbox.poll(SESSION)).message.inbox;
  now += 61;
  const result = await inbox.poll(SESSION);
  assert.equal(result.message.key.id, "later");
  assert.equal(result.attention[0].reason, "unclaimed");
  assert.equal((await inbox.begin(original)).started, false);
  const restarted = await create().start(); await restarted.open(OTHER_SESSION);
  const recovered = await restarted.poll(OTHER_SESSION);
  assert.equal(recovered.attention[0].inbox.id, original.id);
  assert.equal(recovered.counts.blocked, 1);
});

test("processing watchdog retains uncertain actions without automatic replay", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now, processingTimeoutMs: 60 });
  await enqueue(inbox); await enqueue(inbox, message("later"));
  const reference = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(reference); now += 61;
  const result = await inbox.poll(SESSION);
  assert.equal(result.message.key.id, "later");
  assert.equal(result.attention[0].reason, "processing_timeout");
  assert.equal((await inbox.begin(reference)).started, false);
  assert.deepEqual(await inbox.complete(reference), { status: "completed" });
});

test("unprepared messages can be discarded immediately or held by the watchdog", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now, preparationTimeoutMs: 60 });
  await inbox.enqueue("default", message());
  let result = await inbox.poll(SESSION);
  await inbox.resolve(result.inbox, "discard");
  await inbox.enqueue("default", message("stuck"));
  now += 61;
  result = await inbox.poll(SESSION);
  assert.equal(result.status, "blocked");
  assert.equal(result.attention[0].reason, "preparation_timeout");
  await inbox.resolve(result.inbox, "discard");
  assert.equal((await inbox.poll(SESSION)).status, "empty");
});

test("retries preserve arrival time and cannot overlap a later active message", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now, claimTimeoutMs: 60 });
  await enqueue(inbox); await enqueue(inbox, message("later"));
  const first = (await inbox.poll(SESSION)).message.inbox;
  now += 61;
  const later = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(later);
  await inbox.resolve(first, "retry");
  assert.equal((await inbox.poll(SESSION)).status, "processing");
  const retriedEntry = inbox.state.entries[0];
  await assert.rejects(inbox.begin({ ...first, receipt: retriedEntry.receipt }), { code: "inbox_message_out_of_order" });
  await inbox.complete(later);
  const retried = await inbox.poll(SESSION);
  assert.equal(retried.message.inbox.received_at, first.received_at);
  assert.equal((await inbox.begin(retried.message.inbox)).started, true);
});

test("temporary preparation errors back off and succeed or become terminal after a bounded budget", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now, preparationRetryMs: 10 });
  const id = await inbox.enqueue("default", message());
  const failure = { status: "error", error: "download_failed" };
  assert.equal(await inbox.ready(id, failure), false);
  assert.equal(inbox.unready("default").length, 0);
  now += 10;
  assert.equal(inbox.unready("default").length, 1);
  assert.equal(await inbox.ready(id, failure), false);
  now += 19; assert.equal(inbox.unready("default").length, 0);
  now += 1;
  assert.equal(await inbox.ready(id, failure), true);
  const result = await inbox.poll(SESSION);
  assert.equal(result.message.media.error, "download_failed");
  await inbox.resolve(result.message.inbox, "retry");
  assert.equal(inbox.unready("default").length, 1);
  await inbox.ready(id, { status: "ready", id: "1bcdfb31-7cd3-47df-8595-17fcaf84943a" });
  assert.equal((await inbox.poll(SESSION)).message.media.status, "ready");
});

test("missing media is delivered as an explicit error while temporary failures retain the pin", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now });
  const media = { status: "ready", id: "1bcdfb31-7cd3-47df-8595-17fcaf84943a" };
  await enqueue(inbox, message(), "default", media);
  await enqueue(inbox, message("other"), "other");
  const temporary = await inbox.poll(SESSION, async () => ({ ...media, status: "error", error: "inbox_media_unavailable" }));
  assert.equal(temporary.message.clientId, "other");
  assert.equal(inbox.isMediaPinned(media.id), true);
  now += 100;
  const missing = await inbox.poll(SESSION, async () => ({ ...media, status: "error", error: "inbox_media_missing" }));
  assert.equal(missing.message.clientId, "default");
  assert.equal(missing.message.media.error, "inbox_media_missing");
  assert.equal(inbox.state.entries[0].mediaWaitAt, undefined);
});

test("unchanged polls avoid snapshot cloning and disk writes with a full receipt history", async (t) => {
  const { inbox } = await fixture(t);
  // Seed a real persisted history in one transaction, avoiding thousands of test fsyncs.
  await inbox.transaction((state) => {
    for (let i = 0; i < 10000; i++) state.entries.push({
      id: i.toString(16).padStart(64, "0"), receipt: "c".repeat(64), clientId: "default",
      sequence: ++state.sequence, status: "completed", completedAt: Date.now(),
      chatId: "12025550123@s.whatsapp.net", messageId: `old-${i}`, receivedAt: 1, ready: true,
    });
  });
  assert.equal(inbox.state.entries.length, 1000);
  assert.ok((await fs.stat(inbox.file)).size < 300000);
  await enqueue(inbox);
  await inbox.poll(SESSION); // First offer is deliberately durable.
  const snapshot = inbox.state;
  inbox.fsPromises = { ...fs, open: async () => { throw new Error("Unexpected write on read-only poll"); } };
  for (let i = 0; i < 100; i++) assert.equal((await inbox.poll(SESSION)).status, "pending");
  assert.equal(inbox.state, snapshot);
});

test("an uncertain enqueue is held after restart rather than replaying a possible live fallback", async (t) => {
  const { inbox, create } = await fixture(t);
  inbox.syncDirectory = async () => { throw new Error("Fictional flush failure"); };
  await assert.rejects(inbox.enqueue("default", message()), { code: "inbox_storage_unavailable" });
  const recovered = await create().start(); await recovered.open(OTHER_SESSION);
  const result = await recovered.poll(OTHER_SESSION);
  assert.equal(result.status, "blocked");
  assert.equal(result.attention[0].reason, "preparation_interrupted");
});

test("inspection does not begin the claim deadline and workflow failures can be held immediately", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now, claimTimeoutMs: 60 });
  await enqueue(inbox);
  await inbox.poll(SESSION, undefined, undefined, false);
  now += 60000;
  const result = await inbox.poll(SESSION);
  assert.equal(result.status, "pending");
  await inbox.begin(result.message.inbox);
  assert.equal((await inbox.resolve(result.message.inbox, "hold")).status, "interrupted");
  assert.equal((await inbox.poll(SESSION)).attention[0].reason, "workflow_failed");
});

test("receipt expiry admits the first new delivery and failed preparation cannot mutate the prior snapshot", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now, receiptRetentionMs: 60 });
  await enqueue(inbox);
  const reference = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(reference); await inbox.complete(reference); now += 61;
  const id = await inbox.enqueue("default", message());
  assert.equal(id, reference.id);
  assert.equal(inbox.state.entries.length, 1);
  const snapshot = JSON.stringify(inbox.state);
  inbox.fsPromises = { ...fs, rename: async () => { throw new Error("Fictional write failure"); } };
  await assert.rejects(inbox.ready(id, { status: "error", error: "invalid_metadata" }));
  assert.equal(JSON.stringify(inbox.state), snapshot);
});

test("failed media renewal is held after its watchdog and later messages continue", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now, preparationTimeoutMs: 60 });
  const media = { id: "1bcdfb31-7cd3-47df-8595-17fcaf84943a", status: "ready" };
  await enqueue(inbox, message(), "default", media);
  await enqueue(inbox, message("later"));
  await inbox.poll(SESSION, async () => ({ ...media, status: "error", error: "inbox_media_unavailable" }));
  now += 61;
  const result = await inbox.poll(SESSION);
  assert.equal(result.message.key.id, "later");
  assert.equal(result.attention[0].reason, "preparation_timeout");
  assert.equal(inbox.isMediaPinned(media.id), true);
});

test("admission reserves room to prepare, start and complete messages at the storage limit", async (t) => {
  const { inbox } = await fixture(t, { maxBytes: 16000 });
  const large = message(); large.message.conversation = "x".repeat(6000);
  const id = await inbox.enqueue("default", large);
  await assert.rejects(inbox.enqueue("default", { ...large, key: { ...large.key, id: "next" } }), { code: "inbox_full" });
  await inbox.ready(id, { status: "ready", original_filename: "x".repeat(2000) });
  const reference = (await inbox.poll(SESSION)).message.inbox;
  assert.equal((await inbox.begin(reference)).started, true);
  await inbox.complete(reference);
  assert.equal((await inbox.poll(SESSION)).status, "empty");
});

test("a backwards wall-clock correction cannot strand preparation backoff or watchdogs", async (t) => {
  let now = 100000;
  const { inbox } = await fixture(t, { now: () => now, preparationRetryMs: 10, preparationTimeoutMs: 60 });
  const id = await inbox.enqueue("default", message());
  await inbox.ready(id, { status: "error", error: "timeout" });
  now = 1000;
  assert.equal((await inbox.poll(SESSION)).status, "preparing");
  now += 10;
  assert.equal(inbox.unready("default").length, 1);
  now += 51;
  assert.equal((await inbox.poll(SESSION)).attention[0].reason, "preparation_timeout");
});

test("a new HA session gets a fresh claim window after a long outage, but reopening the same session does not", async (t) => {
  let now = 1000;
  const { inbox } = await fixture(t, { now: () => now, claimTimeoutMs: 60 });
  await enqueue(inbox);
  const original = (await inbox.poll(SESSION)).message.inbox;
  now += 1000000;
  await inbox.open(OTHER_SESSION);
  const recovered = await inbox.poll(OTHER_SESSION);
  assert.equal(recovered.status, "pending");
  assert.deepEqual(recovered.attention, []);
  assert.equal(recovered.message.inbox.receipt, original.receipt);
  assert.equal(recovered.message.inbox.received_at, original.received_at);
  await assert.rejects(inbox.begin(original), { code: "invalid_inbox_reference" });
  now += 61;
  await inbox.open(OTHER_SESSION);
  const blocked = await inbox.poll(OTHER_SESSION);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.attention[0].reason, "unclaimed");
});
