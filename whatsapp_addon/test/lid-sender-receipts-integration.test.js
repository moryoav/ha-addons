const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { WhatsappClient } = require("../whatsapp");
const { parseOptions, createAddonRuntime, startAddon } = require("../runtime");
const { RequestValidationError } = require("../validation");

const OWN = "999999999999991";
const PEER = "999999999999992@lid";
const TIME = 1788603786;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const incoming = () => ({
  tag: "message", attrs: { from: `${OWN}:22@lid`, recipient: PEER,
    id: "fictional-message", t: String(TIME) },
  content: [{ tag: "enc", attrs: { type: "pkmsg" }, content: Buffer.from("fictional ciphertext") }],
});
const upsert = () => ({ type: "notify", messages: [{
  key: { id: "fictional-message", remoteJid: PEER, fromMe: true },
  messageTimestamp: TIME, message: { conversation: "Fictional message" },
}] });

const harness = async (settings = {}) => {
  const sockets = [];
  const sent = [];
  const baileys = {
    proto: (await import("@whiskeysockets/baileys")).proto,
    DisconnectReason: { loggedOut: 401 },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
    default: () => {
      const ws = new EventEmitter(); ws.isOpen = true;
      const ev = new EventEmitter();
      const socket = {
        ws, ev, receipts: [],
        user: { lid: `${OWN}:9@lid`, id: "12025550123:9@s.whatsapp.net" },
        async sendNode(node) { this.receipts.push(node); },
        async sendMessage(jid, message, options) {
          sent.push({ jid, message, options });
          return { key: { id: `local-${sent.length}`, remoteJid: jid, fromMe: true }, message };
        },
        async end() { ws.isOpen = false; ev.emit("connection.update", { connection: "close" }); },
      };
      sockets.push(socket);
      return socket;
    },
  };
  const client = new WhatsappClient({
    path: "fictional-session", baileys, socketLogger: {},
    autoConnect: false, offline: false, ...settings,
  });
  await client.connect();
  sockets[0].ev.emit("connection.update", { connection: "open" });
  return { client, sockets, sent };
};

test("default and explicit false do not load the helper or attach tracking handlers", async () => {
  assert.equal(require.cache[require.resolve("../lid-sender-receipts")], undefined);
  for (const settings of [{}, { experimentalLidSenderReceipts: false }]) {
    const h = await harness(settings);
    const socket = h.sockets[0];
    const delivered = [];
    h.client.on("msg_sent", (message) => delivered.push(message));
    assert.equal(socket.ws.listenerCount("CB:message"), 0);
    assert.equal(socket.ev.listenerCount("messages.upsert"), 2);
    socket.ws.emit("CB:message", incoming());
    socket.ev.emit("messages.upsert", upsert());
    await tick();
    assert.equal(delivered.length, 1);
    assert.deepEqual(socket.receipts, []);
    await h.client.disconnect();
  }
  assert.equal(require.cache[require.resolve("../lid-sender-receipts")], undefined);
});

test("enabled wiring works without Decryption Diagnostics and preserves normal message events", async () => {
  const h = await harness({ experimentalLidSenderReceipts: true });
  const socket = h.sockets[0];
  const messages = [];
  const diagnostics = [];
  h.client.on("msg_sent", (message) => messages.push(message));
  h.client.on("decryption_diagnostic", (event) => diagnostics.push(event));
  assert.equal(socket.ws.listenerCount("CB:message"), 1);
  socket.ws.emit("CB:message", incoming());
  socket.ev.emit("messages.upsert", upsert());
  await tick();
  assert.equal(socket.receipts.length, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.conversation, "Fictional message");
  assert.deepEqual(diagnostics, []);
  await h.client.disconnect();
  assert.equal(socket.ws.listenerCount("CB:message"), 0);
});

test("enabled diagnostics report a sanitized outcome, independently of the normal send API", async () => {
  const h = await harness({ experimentalLidSenderReceipts: true, decryptionDiagnostics: true });
  const socket = h.sockets[0];
  const diagnostics = [];
  h.client.on("decryption_diagnostic", (event) => {
    if (event.source === "lid_sender_receipts") diagnostics.push(event);
  });
  for (const jid of ["12025550123@s.whatsapp.net", PEER, "12025550123-1@g.us"]) {
    await h.client.sendMessage(jid, { text: "Fictional notification" });
  }
  assert.deepEqual(h.sent.map((item) => item.jid), ["12025550123@s.whatsapp.net", PEER, "12025550123-1@g.us"]);
  assert.deepEqual(socket.receipts, []);
  socket.ws.emit("CB:message", incoming());
  socket.ev.emit("messages.upsert", upsert());
  await tick();
  assert.deepEqual(diagnostics, [{ source: "lid_sender_receipts", outcome: "sent" }]);
  await h.client.disconnect();
});

test("reconnect binds fresh tracking and cannot send for a stale socket", async () => {
  const h = await harness({ experimentalLidSenderReceipts: true });
  const old = h.sockets[0];
  old.ws.emit("CB:message", incoming());
  await h.client.disconnect(true);
  await h.client.connect();
  const current = h.sockets[1];
  current.ev.emit("connection.update", { connection: "open" });
  old.ev.emit("messages.upsert", upsert());
  current.ev.emit("messages.upsert", upsert());
  await tick();
  assert.deepEqual(old.receipts, []);
  assert.deepEqual(current.receipts, []);
  assert.equal(old.ws.listenerCount("CB:message"), 0);
  current.ws.emit("CB:message", incoming());
  current.ev.emit("messages.upsert", upsert());
  await tick();
  assert.equal(current.receipts.length, 1);
  await h.client.disconnect();
});

test("settings are strictly boolean, absent/false retain the legacy default, and true is forwarded", () => {
  for (const flag of [undefined, false, true]) {
    const options = parseOptions(JSON.stringify({ clients: ["default"], experimental_lid_sender_receipts: flag }));
    assert.equal(options.experimentalLidSenderReceipts === true, flag === true);
    let settings;
    createAddonRuntime({ ...options, clientFactory: (value) => {
      settings = value; return new EventEmitter();
    } });
    assert.equal(settings.experimentalLidSenderReceipts === true, flag === true);
    if (flag !== true) assert.equal(Object.hasOwn(settings, "experimentalLidSenderReceipts"), false);
  }
  for (const value of ["true", "false", 1, 0, null, [], {}]) {
    assert.throws(() => parseOptions(JSON.stringify({ clients: ["default"], experimental_lid_sender_receipts: value })), RequestValidationError);
    assert.throws(() => createAddonRuntime({ clientIds: ["default"], experimentalLidSenderReceipts: value }), RequestValidationError);
  }
});

test("startup carries the setting through options loading and retains it after recovery retry", async () => {
  const factories = [];
  const warnings = [];
  const app = await startAddon({
    optionsLoader: async () => parseOptions(JSON.stringify({ clients: ["default"], experimental_lid_sender_receipts: true })),
    clientFactory: (settings) => {
      factories.push(settings);
      const client = new EventEmitter(); client.disconnect = async () => {};
      return client;
    },
    logger: { info() {}, warn: (text) => warnings.push(text), error() {} },
    diagnosticsFactory: () => ({ runId: "0123456789abcdef" }),
    replayHealthDiagnosticsFn: async () => ({ records: [] }),
    readRecoveryRecordFn: async () => undefined,
    persistRecoveryRecordSyncFn: () => {}, clearRecoveryRecordFn: async () => {},
    listenFn: async () => ({}), closeServerFn: async () => {},
    httpClient: { post: async () => {} },
  });
  assert.equal(factories[0].experimentalLidSenderReceipts, true);
  assert.ok(warnings.some((text) => /Experimental LID/.test(text)));
  await app.enterRecovery({ failedDecryptMessages: 10, badMacSessionErrors: 100 });
  assert.equal(app.recovery.active, true); // Guard is NOT disabled by the experiment.
  await app.retryRecovery();
  assert.equal(factories[1].experimentalLidSenderReceipts, true);
  await app.close();
});

test("Supervisor settings default off and Docker explicitly includes the helper", () => {
  const root = path.resolve(__dirname, "..");
  const config = fs.readFileSync(path.join(root, "config.yaml"), "utf8");
  assert.match(config, /experimental_lid_sender_receipts: false/);
  assert.match(config, /experimental_lid_sender_receipts: bool/);
  assert.match(fs.readFileSync(path.join(root, "translations/en.yaml"), "utf8"), /experimental_lid_sender_receipts:/);
  assert.match(fs.readFileSync(path.join(root, "Dockerfile"), "utf8"), /lid-sender-receipts\.js/);
  assert.match(fs.readFileSync(path.join(root, ".dockerignore"), "utf8"), /^!lid-sender-receipts\.js$/m);
});

// Issue #7, 23 Sep: what one socket decrypted was replayed to the next one.
test("a copy decrypted on the previous socket is answered after a reconnect", async () => {
  const h = await harness({ experimentalLidSenderReceipts: true });
  const sent = [];
  h.client.on("msg_sent", (message) => sent.push(message));
  const old = h.sockets[0];
  old.ws.emit("CB:message", incoming());
  old.ev.emit("messages.upsert", upsert());
  await tick();
  assert.equal(old.receipts.length, 1);

  await h.client.disconnect(true);
  await h.client.connect();
  const current = h.sockets[1];
  current.ev.emit("connection.update", { connection: "open" });
  const baileys = [];
  current.ws.on("CB:message", (node) => baileys.push(node));
  current.ws.emit("CB:message", { ...incoming(), attrs: { ...incoming().attrs, offline: "0" } });
  await tick();
  assert.deepEqual(baileys, []);
  assert.equal(current.receipts.length, 1);
  assert.equal(sent.length, 1); // Home Assistant got the message once, from the first socket.
  await h.client.disconnect();
  assert.equal(Object.hasOwn(current.ws, "emit"), false);
});

test("stopping the client forgets which messages it decrypted", async () => {
  const h = await harness({ experimentalLidSenderReceipts: true });
  const first = h.sockets[0];
  first.ws.emit("CB:message", incoming());
  first.ev.emit("messages.upsert", upsert());
  await tick();
  await h.client.disconnect();
  await h.client.connect();
  const next = h.sockets[1];
  next.ev.emit("connection.update", { connection: "open" });
  const baileys = [];
  next.ws.on("CB:message", (node) => baileys.push(node));
  next.ws.emit("CB:message", incoming());
  assert.equal(baileys.length, 1);
  await h.client.disconnect();
});
