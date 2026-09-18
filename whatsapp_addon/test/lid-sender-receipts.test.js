const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { attachLidSenderReceipts } = require("../lid-sender-receipts");

const OWN = "999999999999991";
const PEER = "999999999999992@lid";
const TIME = 1788603786;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const raw = (attrs = {}, type = "pkmsg") => ({
  tag: "message",
  attrs: { id: "fictional-message", from: `${OWN}:22@lid`, recipient: PEER,
    t: String(TIME), ...attrs },
  content: [{ tag: "enc", attrs: { type, v: "2" }, content: Buffer.from("fictional encrypted data") }],
});
const message = (changes = {}) => ({
  key: { id: "fictional-message", fromMe: true, remoteJid: PEER },
  messageTimestamp: TIME,
  message: { conversation: "Fictional private message" },
  ...changes,
});
const harness = (options = {}) => {
  const sends = [];
  const diagnostics = [];
  const ws = new EventEmitter();
  ws.isOpen = true;
  const socket = {
    ws, ev: new EventEmitter(),
    user: { id: "12025550123:9@s.whatsapp.net", lid: `${OWN}:9@lid` },
    async sendNode(node) { sends.push(node); },
  };
  const helper = attachLidSenderReceipts({ socket,
    onDiagnostic: (value) => diagnostics.push(value), ...options });
  const upsert = (value = message(), extra = {}) => socket.ev.emit("messages.upsert", {
    messages: [value], type: "notify", ...extra,
  });
  return { socket, sends, diagnostics, helper, upsert,
    receive: (node = raw()) => ws.emit("CB:message", node) };
};

test("successful direct own-device LID delivery gets one correctly routed sender receipt", async () => {
  const h = harness();
  const node = raw();
  const decoded = message();
  const before = JSON.stringify([node, decoded]);
  h.receive(node);
  await tick();
  assert.deepEqual(h.sends, []); // Never acknowledge ciphertext before decryption.
  h.upsert(decoded);
  h.upsert(decoded); // A second consumer/echo is not a second raw delivery.
  await tick();
  assert.deepEqual(h.sends, [{ tag: "receipt", attrs: {
    id: "fictional-message", type: "sender", to: `${OWN}:22@lid`, recipient: PEER,
  } }]);
  assert.equal(JSON.stringify([node, decoded]), before);
  assert.deepEqual(h.diagnostics, [{ source: "lid_sender_receipts", outcome: "sent" }]);
  h.helper.close();
});

for (const from of [`${OWN}@lid`, `${OWN}:22@lid`]) {
  for (const encType of ["pkmsg", "msg"]) {
    test(`accepts ${encType} from own ${from.includes(":") ? "companion" : "phone"} with offline delivery`, async () => {
      const h = harness();
      h.receive(raw({ from, offline: "1" }, encType));
      h.upsert(message(), { type: "append" });
      await tick();
      assert.equal(h.sends.length, 1);
      assert.equal(h.sends[0].attrs.to, from);
      h.helper.close();
    });
  }
}

for (const [name, attrs] of Object.entries({
  "another account": { from: "999999999999993:22@lid" },
  "current add-on device": { from: `${OWN}:9@lid` },
  "phone-number sender": { from: "12025550123:22@s.whatsapp.net" },
  "phone-number recipient": { recipient: "12025550124@s.whatsapp.net" },
  group: { recipient: "12025550123-1@g.us" },
  broadcast: { recipient: "status@broadcast" },
  newsletter: { recipient: "123456@newsletter" },
  "peer sync": { category: "peer" },
  "unknown category": { category: "other" },
  participant: { participant: `${OWN}:22@lid` },
  "device recipient": { recipient: "999999999999992:1@lid" },
  "missing recipient": { recipient: undefined },
  "missing ID": { id: undefined },
  "oversized ID": { id: "x".repeat(257) },
  "invalid sender device": { from: `${OWN}:99999@lid` },
})) {
  test(`does not track or receipt ${name}`, async () => {
    const h = harness();
    h.receive(raw(attrs));
    h.upsert();
    await tick();
    assert.deepEqual(h.sends, []);
    assert.equal(h.helper.stats.tracked, 0);
    h.helper.close();
  });
}

for (const [name, change] of Object.entries({
  "wrong chat": { key: { id: "fictional-message", fromMe: true, remoteJid: "999999999999993@lid" } },
  "wrong ID": { key: { id: "other-message", fromMe: true, remoteJid: PEER } },
  "not from us": { key: { id: "fictional-message", fromMe: false, remoteJid: PEER } },
  "group participant": { key: { id: "fictional-message", fromMe: true, remoteJid: PEER, participant: `${OWN}:22@lid` } },
  ciphertext: { message: undefined, messageStubType: 2 },
  "partial failed decrypt": { messageStubType: 2 },
  "missing content": { message: undefined },
  "malformed content": { message: [] },
})) {
  test(`does not acknowledge an upsert with ${name}`, async () => {
    const h = harness();
    h.receive();
    h.upsert(message(change));
    await tick();
    assert.deepEqual(h.sends, []);
    h.helper.close();
  });
}

// Baileys sends its own (misrouted) receipt for every decrypted payload, so each
// of these stays pending and replays unless the corrected receipt covers it too.
for (const [name, payload] of Object.entries({
  "delete for everyone": { protocolMessage: { type: 0, key: { id: "older-message" } } },
  edit: { protocolMessage: { type: 14, editedMessage: { conversation: "edited" } } },
  "wrapped control": { ephemeralMessage: { message: { protocolMessage: { type: 3 } } } },
  "text plus control": { conversation: "hello", protocolMessage: {} },
  "sender keys": { senderKeyDistributionMessage: {} },
  pin: { pinInChatMessage: {} },
  "content unknown to this build": { unknownFutureMessage: {} },
  "content with no known fields": {},
})) {
  test(`acknowledges decrypted ${name}`, async () => {
    const h = harness();
    h.receive();
    h.upsert(message({ message: payload }));
    await tick();
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].attrs.to, `${OWN}:22@lid`);
    h.helper.close();
  });
}

for (const [name, contents] of Object.entries({
  "missing encryption": [],
  plaintext: [{ tag: "plaintext", content: Buffer.from("text") }],
  unavailable: [...raw().content, { tag: "unavailable", attrs: {} }],
  "unknown encryption": raw({}, "msmsg").content,
  "multiple ciphertexts": [...raw().content, ...raw().content],
  "empty ciphertext": [{ tag: "enc", attrs: { type: "msg" }, content: Buffer.alloc(0) }],
})) {
  test(`does not track ${name}`, async () => {
    const h = harness();
    h.receive({ ...raw(), content: contents });
    h.upsert();
    await tick();
    assert.equal(h.helper.stats.tracked, 0);
    assert.deepEqual(h.sends, []);
    h.helper.close();
  });
}

test("local outbound echoes, history-only upserts and placeholder responses need a qualifying raw stanza", async () => {
  const h = harness();
  h.upsert();
  h.receive();
  h.upsert(message(), { requestId: "placeholder-request" });
  h.upsert(message(), { type: "history" });
  await tick();
  assert.deepEqual(h.sends, []);
  h.helper.close();
});

test("accepts ordinary media, wrapped text, any timestamp form, and bare own LID", async () => {
  for (const payload of [{ imageMessage: {} }, { audioMessage: {} },
    { ephemeralMessage: { message: { conversation: "text" } } },
    { viewOnceMessageV2: { message: { videoMessage: {} } } }]) {
    // Baileys' event buffer can replace a merged message's timestamp, and a raw
    // stanza's `t` plays no part in the receipt, so neither is matched on.
    for (const messageTimestamp of [{ toString: () => String(TIME) }, TIME + 60, undefined]) {
      const h = harness();
      h.socket.user.lid = `${OWN}@lid`;
      h.receive(raw({ t: undefined }));
      h.upsert(message({ message: payload, messageTimestamp }));
      await tick();
      assert.equal(h.sends.length, 1);
      h.helper.close();
    }
  }
});

// Baileys freezes `socket.user` at creation and replaces `creds.me` at login, so on
// the first connection after a pairing the own LID exists only in the live credentials.
test("own identity is read from the live credentials, not the socket's creation-time snapshot", async () => {
  const h = harness();
  h.socket.user = { id: "12025550123:9@s.whatsapp.net" };
  h.socket.authState = { creds: { me: { id: "12025550123:9@s.whatsapp.net" } } };
  h.receive(); h.upsert(); await tick();
  assert.deepEqual(h.sends, []); // No LID known yet: nothing is guessed.

  h.socket.authState.creds.me = { ...h.socket.authState.creds.me, lid: `${OWN}:9@lid` };
  assert.equal(h.socket.user.lid, undefined);
  h.receive(raw({ id: "after-login" }));
  h.upsert(message({ key: { id: "after-login", fromMe: true, remoteJid: PEER } }));
  await tick();
  assert.deepEqual(h.sends.map((node) => node.attrs.id), ["after-login"]);

  // A different account logging in before the queued write must cancel it.
  h.receive(raw({ id: "stale-login" }));
  h.upsert(message({ key: { id: "stale-login", fromMe: true, remoteJid: PEER } }));
  h.socket.authState.creds.me = { id: "12025550199:9@s.whatsapp.net", lid: "999999999999993:9@lid" };
  await tick();
  assert.deepEqual(h.sends.map((node) => node.attrs.id), ["after-login"]);
  h.helper.close();
});

test("missing own LID or current device is not guessed", async () => {
  for (const property of ["lid", "id"]) {
    const h = harness();
    delete h.socket.user[property];
    h.receive(); h.upsert();
    await tick();
    assert.deepEqual(h.sends, []);
    h.helper.close();
  }
});

test("an ambiguous originating device is never guessed, and is reported once", async () => {
  const h = harness();
  h.receive(); h.receive(raw({ from: `${OWN}:23@lid` })); h.receive(raw({ from: `${OWN}@lid` }));
  h.upsert(); h.receive(); h.upsert();
  await tick();
  assert.deepEqual(h.sends, []);
  assert.deepEqual(h.diagnostics.map((d) => d.outcome), ["ambiguous"]);
  h.helper.close();
});

// Issue #7: after a replay fails, Baileys asks the origin device to retry. Its answer
// reuses the ID with fresh ciphertext, and must be acknowledged or it replays forever.
const retryCopy = (type = "msg") => ({ ...raw({ t: String(TIME + 3000) }),
  content: [{ tag: "enc", attrs: { type, v: "2", count: "1" }, content: Buffer.from("fresh ciphertext") }] });
const failed = () => message({ message: undefined, messageStubType: 2 });

test("a retry copy with fresh ciphertext and timestamp earns the receipt its failed replay could not", async () => {
  const h = harness();
  h.receive(raw({ offline: "1" }, "msg"));
  h.upsert(failed(), { type: "append" });
  await tick();
  assert.deepEqual(h.sends, []); // Never acknowledge the copy that failed.
  h.receive(retryCopy());
  h.upsert(message({ messageTimestamp: TIME + 3000 }));
  await tick();
  assert.deepEqual(h.sends.map((node) => node.attrs), [
    { id: "fictional-message", type: "sender", to: `${OWN}:22@lid`, recipient: PEER }]);
  assert.deepEqual(h.diagnostics.map((d) => d.outcome), ["sent"]);
  h.helper.close();
});

test("a replay rejected without any upsert does not block its retry copy", async () => {
  const h = harness();
  h.receive(raw({ offline: "1" })); // pkmsg replay: Baileys NACKs it and emits nothing.
  h.receive(retryCopy("pkmsg"));
  h.upsert();
  await tick();
  assert.equal(h.sends.length, 1);
  h.helper.close();
});

test("copies merged into one buffered upsert are acknowledged once, separate successes once each", async () => {
  const merged = harness();
  merged.receive(raw({ offline: "1" }, "msg")); merged.receive(retryCopy());
  merged.upsert(); // Baileys' event buffer keeps only the latest message per key.
  await tick();
  assert.equal(merged.sends.length, 1);
  merged.helper.close();

  const separate = harness();
  separate.receive(retryCopy()); separate.upsert(); await tick();
  separate.receive(retryCopy("pkmsg")); separate.upsert(); await tick();
  separate.upsert(); await tick(); // An echo of the second copy earns nothing more.
  assert.equal(separate.sends.length, 2);
  separate.helper.close();
});

test("a refreshed record keeps expiry order, so newer entries are still pruned on time", async () => {
  let now = 0;
  const h = harness({ now: () => now, ttlMs: 100 });
  h.receive(raw({ id: "a" }));
  now = 50; h.receive(raw({ id: "b" }));
  now = 90; h.receive(raw({ id: "a" })); // Refreshed: expires at 190, after "b" at 150.
  now = 160; h.receive(raw({ id: "c" }));
  assert.equal(h.helper.stats.tracked, 2); // "b" pruned, "a" and "c" remain.
  h.upsert(message({ key: { id: "a", remoteJid: PEER, fromMe: true } }));
  await tick();
  assert.equal(h.sends.length, 1);
  h.helper.close();
});

test("collision arriving after enqueue cancels the optional write", async () => {
  const h = harness();
  h.receive(); h.upsert();
  h.receive(raw({ from: `${OWN}:23@lid` }));
  await tick();
  assert.deepEqual(h.sends, []);
  h.helper.close();
});

test("a later raw redelivery needs its own successful upsert", async () => {
  const h = harness();
  h.receive(); h.upsert(); await tick();
  h.receive(); await tick();
  assert.equal(h.sends.length, 1);
  h.upsert(message({ message: undefined, messageStubType: 2 })); await tick();
  assert.equal(h.sends.length, 1);
  h.receive(); h.upsert(); await tick();
  assert.equal(h.sends.length, 2);
  h.helper.close();
});

test("tracking expires and cannot grow beyond its cap", async () => {
  let now = 0;
  const h = harness({ now: () => now, maxEntries: 2, ttlMs: 100 });
  h.receive(raw({ id: "a" })); h.receive(raw({ id: "b" })); h.receive(raw({ id: "c" }));
  assert.equal(h.helper.stats.tracked, 2);
  h.upsert(message({ key: { id: "a", remoteJid: PEER, fromMe: true } }));
  now = 100;
  h.upsert(message({ key: { id: "c", remoteJid: PEER, fromMe: true } }));
  await tick();
  assert.equal(h.helper.stats.tracked, 0);
  assert.deepEqual(h.sends, []);
  h.helper.close();
});

test("one buffered offline flush of many messages loses no receipts by default", async () => {
  const h = harness();
  const ids = Array.from({ length: 300 }, (_, index) => `offline-${index}`);
  for (const id of ids) h.receive(raw({ id, offline: "1" }));
  h.socket.ev.emit("messages.upsert", { type: "append",
    messages: ids.map((id) => message({ key: { id, remoteJid: PEER, fromMe: true } })) });
  await tick();
  assert.deepEqual(h.sends.map((node) => node.attrs.id), ids);
  assert.ok(!h.diagnostics.some((d) => d.outcome === "queue_full"));
  h.helper.close();
});

test("receipt queue and in-flight writes are bounded even if a write hangs", async () => {
  const h = harness({ maxPending: 2 });
  let release;
  h.socket.sendNode = (node) => { h.sends.push(node); return new Promise((resolve) => { release = resolve; }); };
  h.receive(); h.upsert(); await tick();
  for (const id of ["a", "b", "c", "d"]) {
    h.receive(raw({ id }));
    h.upsert(message({ key: { id, remoteJid: PEER, fromMe: true } }));
  }
  assert.equal(h.sends.length, 1);
  assert.equal(h.helper.stats.queued, 2);
  assert.ok(h.diagnostics.some((d) => d.outcome === "queue_full"));
  h.helper.close();
  release(); await tick();
  assert.equal(h.sends.length, 1);
});

test("sync and async send failures are contained and never retried automatically", async () => {
  for (const fail of [() => { throw new Error("private upstream detail"); },
    async () => { throw new Error("private upstream detail"); }]) {
    const h = harness();
    let calls = 0;
    h.socket.sendNode = () => { calls++; return fail(); };
    h.receive(); h.upsert(); await tick(); await tick();
    assert.equal(calls, 1);
    assert.equal(h.diagnostics[0].outcome, "send_failed");
    assert.doesNotMatch(JSON.stringify(h.diagnostics), /private|999999|fictional-message/);
    h.helper.close();
  }
});

test("diagnostic failure does not interrupt normal listeners or receipt handling", async () => {
  const h = harness({ onDiagnostic: () => { throw new Error("logger down"); } });
  let delivered = 0;
  h.socket.ev.on("messages.upsert", () => delivered++);
  h.receive(); h.upsert(); await tick();
  assert.equal(delivered, 1);
  assert.equal(h.sends.length, 1);
  h.helper.close();
});

test("disconnect removes only our handlers and clears all queued state", async () => {
  const h = harness();
  const other = () => {};
  h.socket.ws.on("CB:message", other);
  h.receive(); h.upsert();
  h.socket.ev.emit("connection.update", { connection: "close" });
  await tick();
  assert.deepEqual(h.sends, []);
  assert.deepEqual(h.helper.stats, { tracked: 0, queued: 0, closed: true });
  assert.deepEqual(h.socket.ws.listeners("CB:message"), [other]);
  assert.equal(h.socket.ev.listenerCount("messages.upsert"), 0);
  assert.equal(h.socket.ev.listenerCount("connection.update"), 0);
  h.helper.close();
});

test("socket replacement, closed transport, or changed account prevents queued receipts", async () => {
  for (const invalidate of [
    (h) => { h.socket.ws.isOpen = false; },
    (h) => { h.socket.user.lid = "999999999999993:9@lid"; },
    (_h, state) => { state.current = false; },
  ]) {
    const state = { current: true };
    const h = harness({ isCurrent: () => state.current });
    h.receive(); h.upsert(); invalidate(h, state);
    await tick();
    assert.deepEqual(h.sends, []);
    h.helper.close();
  }
});

test("separate clients and reconnects cannot reuse another socket's metadata", async () => {
  const old = harness(); const fresh = harness();
  old.receive(); fresh.upsert();
  old.helper.close(); old.upsert();
  await tick();
  assert.deepEqual(old.sends, []);
  assert.deepEqual(fresh.sends, []);
  fresh.receive(); fresh.upsert(); await tick();
  assert.equal(fresh.sends.length, 1);
  fresh.helper.close();
});

test("unsupported sockets fail closed, and malformed events never throw", async () => {
  const diagnostics = [];
  assert.equal(attachLidSenderReceipts({ socket: {}, onDiagnostic: (d) => diagnostics.push(d) }), undefined);
  assert.equal(diagnostics[0].outcome, "unsupported_socket");
  const h = harness();
  for (const value of [null, undefined, [], {}, { attrs: {} }]) {
    assert.doesNotThrow(() => h.receive(value));
    assert.doesNotThrow(() => h.socket.ev.emit("messages.upsert", value));
  }
  await tick();
  assert.deepEqual(h.sends, []);
  h.helper.close();
});
