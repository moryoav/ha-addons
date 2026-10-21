const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { WhatsappClient } = require("../whatsapp");
const { parseOptions, createAddonRuntime, startAddon } = require("../runtime");

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

test("sender receipts are always active, including with a legacy false setting", async () => {
  for (const settings of [{}, { experimentalLidSenderReceipts: false }, { experimentalLidSenderReceipts: true }]) {
    const h = await harness(settings);
    const socket = h.sockets[0];
    const delivered = [];
    h.client.on("msg_sent", (message) => delivered.push(message));
    assert.equal(socket.ws.listenerCount("CB:message"), 1);
    socket.ws.emit("CB:message", incoming());
    socket.ev.emit("messages.upsert", upsert());
    await tick();
    assert.equal(delivered.length, 1);
    assert.equal(socket.receipts.length, 1);
    await h.client.disconnect();
    assert.equal(socket.ws.listenerCount("CB:message"), 0);
  }
});

test("sender receipts preserve normal message events without decryption diagnostics", async () => {
  const h = await harness();
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

test("legacy diagnostic settings cannot enable tracing or change the normal send API", async () => {
  const h = await harness({ decryptionDiagnostics: true });
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
  assert.deepEqual(diagnostics, []);
  assert.equal(socket.receipts.length, 1);
  await h.client.disconnect();
});

test("reconnect binds fresh tracking and cannot send for a stale socket", async () => {
  const h = await harness();
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

test("retired settings are ignored and never forwarded to clients", () => {
  for (const flag of [undefined, false, true, "true", "false", 1, 0, null, [], {}]) {
    const options = parseOptions(JSON.stringify({ clients: ["default"], experimental_lid_sender_receipts: flag, decryption_diagnostics: flag }));
    assert.equal(Object.hasOwn(options, "experimentalLidSenderReceipts"), false);
    assert.equal(Object.hasOwn(options, "decryptionDiagnostics"), false);
    let settings;
    createAddonRuntime({ ...options, experimentalLidSenderReceipts: flag, decryptionDiagnostics: flag, clientFactory: (value) => {
      settings = value; return new EventEmitter();
    } });
    assert.equal(Object.hasOwn(settings, "experimentalLidSenderReceipts"), false);
    assert.equal(Object.hasOwn(settings, "decryptionDiagnostics"), false);
  }
});

test("startup and recovery retry ignore retired options and preserve the recovery guard", async () => {
  const factories = [];
  const warnings = [];
  const app = await startAddon({
    apiTokenLoader: async () => "fictional-runtime-token",
    optionsLoader: async () => parseOptions(JSON.stringify({ clients: ["default"], experimental_lid_sender_receipts: false, decryption_diagnostics: true })),
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
  assert.equal(Object.hasOwn(factories[0], "experimentalLidSenderReceipts"), false);
  assert.equal(Object.hasOwn(factories[0], "decryptionDiagnostics"), false);
  assert.equal(warnings.some((text) => /Experimental LID/.test(text)), false);
  await app.enterRecovery({ failedDecryptMessages: 10, badMacSessionErrors: 100 });
  assert.equal(app.recovery.active, true);
  await app.retryRecovery();
  assert.equal(Object.hasOwn(factories[1], "experimentalLidSenderReceipts"), false);
  assert.equal(Object.hasOwn(factories[1], "decryptionDiagnostics"), false);
  await app.close();
});

test("retired settings are absent from Supervisor configuration and Docker retains the helper", () => {
  const root = path.resolve(__dirname, "..");
  const config = fs.readFileSync(path.join(root, "config.yaml"), "utf8");
  const translations = fs.readFileSync(path.join(root, "translations/en.yaml"), "utf8");
  for (const text of [config, translations]) {
    assert.doesNotMatch(text, /experimental_lid_sender_receipts|decryption_diagnostics/);
  }
  assert.match(fs.readFileSync(path.join(root, "Dockerfile"), "utf8"), /lid-sender-receipts\.js/);
  assert.match(fs.readFileSync(path.join(root, ".dockerignore"), "utf8"), /^!lid-sender-receipts\.js$/m);
});

// Issue #7, 23 Sep: what one socket decrypted was replayed to the next one.
test("a copy decrypted on the previous socket is answered after a reconnect", async () => {
  const h = await harness();
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
  const h = await harness();
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
