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
  "missing timestamp": { t: undefined },
  "invalid timestamp": { t: "not-a-time" },
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
  "wrong timestamp": { messageTimestamp: TIME + 1 },
  "missing timestamp": { messageTimestamp: undefined },
  ciphertext: { message: undefined, messageStubType: 2 },
  "partial failed decrypt": { messageStubType: 2 },
  "internal category": { category: "peer" },
  protocol: { message: { protocolMessage: { type: 5 } } },
  "sender keys": { message: { senderKeyDistributionMessage: {} } },
  "text plus control": { message: { conversation: "hello", protocolMessage: {} } },
  "empty content": { message: {} },
  "unknown content": { message: { unknownFutureMessage: {} } },
  "wrapped control": { message: { ephemeralMessage: { message: { protocolMessage: {} } } } },
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

for (const [name, contents] of Object.entries({
  "missing encryption": [],
  plaintext: [{ tag: "plaintext", content: Buffer.from("text") }],
  unavailable: [...raw().content, { tag: "unavailable", attrs: {} }],
  "unknown encryption": raw({}, "msmsg").content,
  "multiple ciphertexts": [...raw().content, ...raw().content],
  "oversized ciphertext": [{ tag: "enc", attrs: { type: "msg" }, content: Buffer.alloc(1024 * 1024 + 1) }],
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

test("accepts ordinary media, wrapped text, protobuf Long timestamps, and bare own LID", async () => {
  for (const payload of [{ imageMessage: {} }, { audioMessage: {} },
    { ephemeralMessage: { message: { conversation: "text" } } },
    { viewOnceMessageV2: { message: { videoMessage: {} } } }]) {
    const h = harness();
    h.socket.user.lid = `${OWN}@lid`;
    h.receive();
    h.upsert(message({ message: payload, messageTimestamp: { toString: () => String(TIME) } }));
    await tick();
    assert.equal(h.sends.length, 1);
    h.helper.close();
  }
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

test("ambiguous origin, timestamp or ciphertext is never guessed", async () => {
  for (const second of [raw({ from: `${OWN}:23@lid` }), raw({ t: String(TIME + 1) }),
    { ...raw(), content: [{ tag: "enc", attrs: { type: "msg" }, content: Buffer.from("different") }] }]) {
    const h = harness();
    h.receive(); h.receive(second); h.upsert();
    await tick();
    assert.deepEqual(h.sends, []);
    assert.equal(h.diagnostics[0].outcome, "ambiguous");
    h.helper.close();
  }
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
