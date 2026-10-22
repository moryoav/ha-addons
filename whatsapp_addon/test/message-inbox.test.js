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
  assert.deepEqual(result.counts, { pending: 2, processing: 0, interrupted: 0 });
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

test("an interrupted action blocks later messages until explicit resolution", async (t) => {
  const { inbox } = await fixture(t); await enqueue(inbox); await enqueue(inbox, message("later"));
  const reference = (await inbox.poll(SESSION)).message.inbox;
  await inbox.begin(reference); await inbox.open(OTHER_SESSION);
  const interrupted = await inbox.poll(OTHER_SESSION);
  assert.equal(interrupted.inbox.id, reference.id);
  assert.equal(interrupted.status, "interrupted");
  await inbox.resolve(interrupted.inbox, "discard");
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

test("unprepared media survives restart and blocks later ready messages", async (t) => {
  const { inbox, create } = await fixture(t); await inbox.enqueue("default", message());
  await enqueue(inbox, message("second"));
  const next = await create().start(); await next.open(SESSION);
  assert.equal(next.unready("default").length, 1);
  assert.equal((await next.poll(SESSION)).status, "preparing");
});

test("a stale HA session cannot consume or mutate the current inbox", async (t) => {
  const { inbox } = await fixture(t); await enqueue(inbox);
  const reference = (await inbox.poll(SESSION)).message.inbox; await inbox.open(OTHER_SESSION);
  await assert.rejects(inbox.poll(SESSION), { code: "inbox_session_changed" });
  await assert.rejects(inbox.begin(reference), { code: "invalid_inbox_reference" });
});

test("inbox API requires authentication and only explicit requests change processing state", async (t) => {
  const { inbox } = await fixture(t); await enqueue(inbox);
  const app = createApiApp({ clients: {}, sharedSecret: "fictional-api-token", messageInbox: inbox });
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
