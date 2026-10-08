const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const {
  WhatsappClient,
  WhatsappDisconnectedError,
  WhatsappProtocolError,
  WhatsappUpstreamError,
  normalizeRecipientJid,
} = require("../whatsapp");
const { RequestValidationError } = require("../validation");
const { createAddonRuntime } = require("../runtime");

const FICTIONAL_NUMBER = "12025550123";
const FICTIONAL_JID = `${FICTIONAL_NUMBER}@s.whatsapp.net`;
const FICTIONAL_LID = "999999999999999@lid";
const FICTIONAL_GROUP_JID = "120363000000000000@g.us";

const createHarness = async ({
  onWhatsApp,
  groupMetadata,
  sendMessage,
  decryptionDiagnostics = false,
  downloadMediaMessage,
  configureSocket,
  eventEmitter,
  sessionPath = "session-test",
  account,
  authKeys = {},
  baileysOverrides = {},
} = {}) => {
  const ev = eventEmitter || new EventEmitter();
  const ws = new EventEmitter();
  const calls = {
    end: 0,
    groupMetadata: [],
    onWhatsApp: [],
    presenceSubscribe: [],
    sendMessage: [],
    sendPresenceUpdate: [],
    socketOptions: [],
  };
  const socket = {
    ev,
    ws,
    async end() {
      calls.end += 1;
    },
    async onWhatsApp(jid) {
      calls.onWhatsApp.push(jid);
      return onWhatsApp ? onWhatsApp(jid) : [];
    },
    async groupMetadata(jid) {
      calls.groupMetadata.push(jid);
      if (!groupMetadata) throw new Error("groupMetadata is not configured");
      return groupMetadata(jid);
    },
    async presenceSubscribe(jid) {
      calls.presenceSubscribe.push(jid);
    },
    async readMessages() {},
    async sendMessage(jid, message, options) {
      calls.sendMessage.push({ jid, message, options });
      if (sendMessage) return sendMessage(jid, message, options);
      return { key: { id: "fictional-message-id" } };
    },
    async sendPresenceUpdate(type, jid) {
      calls.sendPresenceUpdate.push({ type, jid });
    },
    async updateProfileStatus() {},
  };
  const baileys = {
    proto: (await import("@whiskeysockets/baileys")).proto,
    extractMessageContent: (await import("@whiskeysockets/baileys")).extractMessageContent,
    decryptPollVote: (await import("@whiskeysockets/baileys")).decryptPollVote,
    downloadMediaMessage,
    DisconnectReason: { loggedOut: 401 },
    default: (options) => {
      calls.socketOptions.push(options);
      return socket;
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    useMultiFileAuthState: async () => ({
      state: { creds: account ? { me: { id: account } } : {}, keys: authKeys },
      saveCreds: async () => {},
    }),
  };
  Object.assign(baileys, baileysOverrides);
  const client = new WhatsappClient({
    path: sessionPath,
    baileys,
    autoConnect: false,
    offline: false,
    decryptionDiagnostics,
  });
  configureSocket?.(socket);
  await client.connect();
  ev.emit("connection.update", { connection: "open" });

  return { baileys, calls, client, ev, socket, ws };
};

for (const fromMe of [false, true]) {
  test(`${fromMe ? "sent" : "incoming"} Home Assistant events use cached archive state with no extra socket calls`, async (t) => {
    const { client, ev, calls } = await createHarness();
    t.after(() => client.disconnect());
    const requests = [];
    createAddonRuntime({ clientIds: ["default"], clientFactory: () => client,
      logger: {}, httpClient: { post: async (...args) => requests.push(args) } });
    const before = JSON.stringify(calls);
    let sequence = 0;
    const send = (jid = FICTIONAL_JID) => ev.emit("messages.upsert", {
      type: "notify", messages: [{ key: { id: `archive-${sequence++}`, remoteJid: jid, fromMe },
        message: { conversation: "Fictional text" } }],
    });
    send();
    ev.emit("messaging-history.set", { chats: [{ id: FICTIONAL_JID, archived: true }] });
    send();
    ev.emit("chats.update", [{ id: FICTIONAL_JID, unreadCount: 2 }]);
    send();
    ev.emit("chats.update", [{ id: FICTIONAL_JID, archived: false }]);
    send();
    ev.emit("chats.upsert", [{ id: FICTIONAL_GROUP_JID, archived: true }]);
    send(FICTIONAL_GROUP_JID);
    send(FICTIONAL_LID);
    ev.emit("chats.delete", [FICTIONAL_JID]);
    send();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests.map(([, body]) => body.chat_archived),
      [null, true, true, false, true, null, null]);
    const event = fromMe ? "whatsapp_message_sent" : "new_whatsapp_message";
    assert.ok(requests.every(([url]) => url.endsWith(`/${event}`)));
    assert.equal(JSON.stringify(calls), before);
  });

  test(`real Baileys buffered chat state is applied before ${fromMe ? "sent" : "incoming"} messages`, async (t) => {
    const { makeEventBuffer, processSyncAction } = await import("@whiskeysockets/baileys");
    const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    const { client, ev } = await createHarness({ eventEmitter: makeEventBuffer(logger) });
    t.after(() => client.disconnect());
    const received = [];
    client.on(fromMe ? "msg_sent" : "msg", (message) => received.push(message));
    for (const [index, archived] of [true, false].entries()) {
      ev.buffer();
      // Baileys queues the message before its chat update, but flushes chats first.
      ev.emit("messages.upsert", { type: "notify", messages: [{
        key: { id: `buffered-${index}`, remoteJid: FICTIONAL_JID, fromMe },
        message: { conversation: "Fictional text" },
      }] });
      if (index === 0) ev.emit("messaging-history.set", {
        chats: [{ id: FICTIONAL_JID, archived: false }], contacts: [], messages: [], isLatest: true,
      });
      processSyncAction({ index: ["archive", FICTIONAL_JID],
        syncAction: { value: { archiveChatAction: { archived } } } }, ev, undefined,
      index === 0 ? { accountSettings: { unarchiveChats: false } } : undefined, logger);
      ev.flush();
    }
    assert.deepEqual(received.map((message) => message.chat_archived), [true, false]);
  });
}

test("incoming messages follow WhatsApp's keep-chats-archived setting", async (t) => {
  const { makeEventBuffer } = await import("@whiskeysockets/baileys");
  const { default: processMessage } = await import("@whiskeysockets/baileys/lib/Utils/process-message.js");
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  for (const unarchiveChats of [false, true]) {
    const { client, ev } = await createHarness({ eventEmitter: makeEventBuffer(logger) });
    t.after(() => client.disconnect());
    const received = [];
    client.on("msg", (message) => received.push(message));
    ev.emit("chats.update", [{ id: FICTIONAL_JID, archived: true }]);
    const message = { key: { id: "auto-unarchive", remoteJid: FICTIONAL_JID, fromMe: false },
      messageTimestamp: 1788696000, message: { conversation: "Fictional text" } };
    ev.buffer();
    ev.emit("messages.upsert", { type: "notify", messages: [message] });
    await processMessage(message, { ev, logger,
      creds: { me: { id: "12025550125@s.whatsapp.net" }, accountSettings: { unarchiveChats } } });
    ev.flush();
    assert.equal(received[0].chat_archived, !unarchiveChats);
  }
});

test("archive cache survives client recreation and is cleared on logout", async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const sessionPath = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-archive-client-"));
  t.after(() => fs.rm(sessionPath, { recursive: true, force: true }));
  const settings = { sessionPath, account: "12025550125:1@s.whatsapp.net" };
  const first = await createHarness(settings);
  first.ev.emit("chats.update", [{ id: FICTIONAL_JID, archived: true }]);
  await first.client.disconnect();
  // Retired sockets cannot repopulate the saved state.
  first.ev.emit("chats.update", [{ id: FICTIONAL_JID, archived: false }]);
  const second = await createHarness(settings);
  const received = [];
  second.client.on("msg", (message) => received.push(message));
  const send = (ev) => ev.emit("messages.upsert", { type: "notify", messages: [{
    key: { id: "after-restart", remoteJid: FICTIONAL_JID, fromMe: false },
    message: { conversation: "Fictional text" },
  }] });
  send(second.ev);
  assert.equal(received[0].chat_archived, true);
  second.ev.emit("connection.update", { connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } } });
  second.ev.emit("chats.update", [{ id: FICTIONAL_JID, archived: true }]);
  await second.client.disconnect();
  const third = await createHarness(settings);
  third.client.on("msg", (message) => received.push(message));
  send(third.ev);
  assert.equal(received[1].chat_archived, null);
  await third.client.disconnect();
});

test("archive flags stay separate between accounts", async (t) => {
  const first = await createHarness();
  const second = await createHarness();
  t.after(async () => { await first.client.disconnect(); await second.client.disconnect(); });
  first.ev.emit("chats.update", [{ id: FICTIONAL_JID, archived: true }]);
  const received = [];
  second.client.on("msg", (message) => received.push(message));
  second.ev.emit("messages.upsert", { type: "notify", messages: [{
    key: { id: "other-account", remoteJid: FICTIONAL_JID, fromMe: false },
    message: { conversation: "Fictional text" },
  }] });
  assert.equal(received[0].chat_archived, null);
});

test("the installed runtime Baileys dependency is exactly 6.7.23", async () => {
  assert.equal(
    require("@whiskeysockets/baileys/package.json").version,
    "6.7.23"
  );
  const baileys = await import("@whiskeysockets/baileys");
  assert.equal(typeof baileys.default, "function");
  assert.equal(typeof baileys.fetchLatestBaileysVersion, "function");
});

test("media detection handles supported messages and wrappers without treating text, quotes or sent messages as downloads", async (t) => {
  const { client } = await createHarness();
  t.after(() => client.disconnect());
  for (const type of ["imageMessage", "audioMessage", "videoMessage", "documentMessage", "stickerMessage"]) {
    const media = { mimetype: "application/octet-stream", url: "https://mmg.whatsapp.net/fictional" };
    for (const wrapper of [null, "ephemeralMessage", "documentWithCaptionMessage", "viewOnceMessageV2"]) {
      const inner = { [type]: media };
      const message = { key: { fromMe: false }, message: wrapper ? { [wrapper]: { message: inner } } : inner };
      assert.equal(client.getMediaContent(message), media);
      assert.equal(client.getMediaContent({ ...message, key: { fromMe: true } }), undefined);
    }
  }
  assert.equal(client.getMediaContent({ message: { conversation: "text" } }), undefined);
  assert.equal(client.getMediaContent({ message: { extendedTextMessage: {
    text: "quote", contextInfo: { quotedMessage: { imageMessage: {} } },
  } } }), undefined);
});

test("media downloads use the connected session for reupload and pass cancellation to the installed helper", async (t) => {
  const { Readable } = require("node:stream");
  const controller = new AbortController();
  const message = { message: { imageMessage: {} } };
  let args;
  let uploaded;
  const { client, socket } = await createHarness({ downloadMediaMessage: async (...values) => {
    args = values;
    await values[3].reuploadRequest(message);
    return Readable.from(["bytes"]);
  } });
  t.after(() => client.disconnect());
  socket.updateMediaMessage = async (value) => { uploaded = value; return value; };
  const stream = await client.downloadMedia(message, { signal: controller.signal, timeoutMs: 1234 });
  assert.equal(uploaded, message);
  assert.equal(args[0], message);
  assert.equal(args[1], "stream");
  assert.equal(args[2].options.signal, controller.signal);
  assert.equal(args[2].options.timeout, 1234);
  assert.equal(args[3].logger.info({ key: "private" }), undefined);
  stream.destroy();
});

test("cancellation while waiting for reupload returns promptly and destroys a late stream", async (t) => {
  const { PassThrough } = require("node:stream");
  let finish;
  const { client } = await createHarness({ downloadMediaMessage: () => new Promise((resolve) => { finish = resolve; }) });
  t.after(() => client.disconnect());
  const controller = new AbortController();
  const task = client.downloadMedia({}, { signal: controller.signal, timeoutMs: 1000 });
  const reason = new Error("cancelled");
  controller.abort(reason);
  await assert.rejects(task, (error) => error === reason);
  const late = new PassThrough();
  finish(late);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.destroyed, true);
});

test("an interrupted HTTP download rejects the installed Baileys decrypt stream without an unhandled error", async (t) => {
  const http = require("node:http");
  const { Writable } = require("node:stream");
  const { pipeline } = require("node:stream/promises");
  const real = await import("@whiskeysockets/baileys");
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Length": "100000" });
    response.write(Buffer.alloc(32));
    setTimeout(() => response.destroy(), 30);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/media`;
  const { client } = await createHarness({ downloadMediaMessage: (message, type, options, ctx) =>
    real.downloadMediaMessage(message, type, { options: {
      ...options.options,
      adapter: (config) => options.options.adapter({ ...config, url }),
    } }, ctx),
  });
  t.after(() => client.disconnect());
  const controller = new AbortController();
  const stream = await client.downloadMedia({ message: { audioMessage: {
    mediaKey: Buffer.alloc(32), url: "https://mmg.whatsapp.net/fictional.enc",
  } } }, { signal: controller.signal, timeoutMs: 1000 });
  await assert.rejects(pipeline(stream, new Writable({ write(chunk, encoding, done) { done(); } })));
});

test("media messages are deduplicated before enrichment and emitted once after readiness", async (t) => {
  const { client, ev } = await createHarness();
  t.after(() => client.disconnect());
  const requests = [];
  const enriched = [];
  let ready;
  createAddonRuntime({
    clientIds: ["default"], clientFactory: () => client, logger: {},
    mediaStore: { enrich: (message) => {
      if (message.type !== "imageMessage") return Promise.resolve(undefined);
      enriched.push(message);
      return new Promise((resolve) => { ready = resolve; });
    } },
    httpClient: { post: async (...args) => requests.push(args) },
  });
  const incoming = { key: { id: "fictional-media", remoteJid: FICTIONAL_JID, fromMe: false },
    message: { imageMessage: { caption: "Fictional caption" } } };
  ev.emit("chats.update", [{ id: FICTIONAL_JID, archived: true }]);
  ev.emit("messages.upsert", { type: "notify", messages: [incoming, incoming, {
    key: { id: "fictional-text", remoteJid: FICTIONAL_JID, fromMe: false },
    message: { conversation: "Fictional text" },
  }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(enriched.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].type, "conversation");
  const media = { status: "ready", local_path: "/media/whatsapp/fictional/file.jpg", url: "/api/whatsapp/media/fictional" };
  ev.emit("chats.update", [{ id: FICTIONAL_JID, archived: false }]);
  ready(media);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1][1], { clientId: "default", type: "imageMessage", ...incoming, chat_archived: true, media });
  assert.equal(incoming.media, undefined);
});

test("Baileys call lifecycle arrays are forwarded to the runtime", async () => {
  const { client, ev } = await createHarness();
  const updates = [];
  const statuses = [
    "offer",
    "ringing",
    "accept",
    "reject",
    "timeout",
    "terminate",
  ];
  const calls = statuses.map((status) => ({
    id: `fictional-call-${status}`,
    from: FICTIONAL_LID,
    chatId: FICTIONAL_LID,
    date: new Date("2026-08-25T12:00:00Z"),
    offline: false,
    status,
  }));
  client.on("call_update", (call) => updates.push(call));

  ev.emit("call", calls);
  ev.emit("call", { status: "offer" });

  assert.deepEqual(updates, calls);
  await client.disconnect();
});

test("opt-in decryption diagnostics expose raw stanzas and complete upserts", async () => {
  const { client, ev, ws } = await createHarness({
    decryptionDiagnostics: true,
  });
  const diagnostics = [];
  client.on("decryption_diagnostic", (diagnostic) => diagnostics.push(diagnostic));

  ws.emit("CB:message", {
    tag: "message",
    attrs: {
      id: "fictional-message-id",
      from: FICTIONAL_JID,
      t: "1788246149",
      offline: "1",
    },
    content: [
      {
        tag: "enc",
        attrs: { type: "msg" },
        content: Buffer.from("fictional ciphertext"),
      },
    ],
  });
  ev.emit("messages.upsert", {
    type: "append",
    requestId: "fictional-request-id",
    messages: [
      {
        key: {
          id: "fictional-message-id",
          remoteJid: FICTIONAL_JID,
          fromMe: false,
        },
        pushName: "Fictional Sender",
        messageTimestamp: 1788246149,
        messageStubType: 2,
        messageStubParameters: ["No matching sessions found for message"],
      },
    ],
  });

  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].source, "raw_message_stanza");
  assert.equal(diagnostics[0].messageId, "fictional-message-id");
  assert.equal(diagnostics[1].source, "messages_upsert");
  assert.equal(diagnostics[1].remoteJid, FICTIONAL_JID);
  assert.equal(diagnostics[1].pushName, "Fictional Sender");
  assert.deepEqual(diagnostics[1].messageStubParameters, [
    "No matching sessions found for message",
  ]);
  await client.disconnect();
});

test("mixed message batches reach separate Home Assistant events", async (t) => {
  const { client, ev } = await createHarness();
  t.after(() => client.disconnect());
  const requests = [];
  const received = [];
  client.on("msg", (message) => received.push(message));
  createAddonRuntime({
    clientIds: ["default"],
    dataRoot: path.resolve("runtime-test-data"),
    clientFactory: () => client,
    logger: {},
    httpClient: {
      async post(...args) {
        requests.push(args);
      },
    },
  });
  const messages = [false, true, true].map((fromMe, index) => ({
    key: {
      id: `fictional-message-${index}`,
      remoteJid: index === 2 ? "12025550123-1234567890@g.us" : FICTIONAL_JID,
      fromMe,
    },
    messageTimestamp: 1788696000,
    message: index === 2
      ? { imageMessage: { caption: "Fictional photo" } }
      : { conversation: "Fictional text" },
  }));

  ev.emit("messages.upsert", { type: "notify", messages });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(received.length, 1);
  assert.equal(received[0].key.fromMe, false);
  assert.equal(requests.length, messages.length);
  for (const [index, message] of messages.entries()) {
    assert.equal(requests[index][0], `http://supervisor/core/api/events/${
      message.key.fromMe ? "whatsapp_message_sent" : "new_whatsapp_message"
    }`);
    assert.deepEqual(requests[index][1], {
      clientId: "default",
      type: index === 2 ? "imageMessage" : "conversation",
      ...message,
      chat_archived: null,
      ...(message.key.fromMe ? { recipient_name: null, recipient_identifiers: [] } : {}),
    });
  }
});

test("outgoing append and notify echoes are deduplicated independently of incoming messages", async (t) => {
  const { client, ev } = await createHarness();
  t.after(() => client.disconnect());
  const sent = [];
  const received = [];
  const duplicates = [];
  client.on("msg_sent", (message) => sent.push(message));
  client.on("msg", (message) => received.push(message));
  client.on("msg_duplicate", (duplicate) => duplicates.push(duplicate));
  const message = {
    key: { id: "fictional-message-id", remoteJid: FICTIONAL_JID, fromMe: true },
    message: { conversation: "Fictional text", messageContextInfo: {} },
  };

  ev.emit("messages.upsert", { type: "append", messages: [message] });
  ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ ...message, key: { ...message.key, remoteJid: FICTIONAL_LID } }],
  });
  ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ ...message, key: { ...message.key, fromMe: false } }],
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].key.fromMe, true);
  assert.deepEqual(sent[0].message, { conversation: "Fictional text" });
  assert.equal(received.length, 1);
  assert.equal(received[0].key.fromMe, false);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].fromMe, true);
});

test("outgoing messages without content do not fire sent events", async (t) => {
  const { client, ev } = await createHarness();
  t.after(() => client.disconnect());
  const sent = [];
  const ignored = [];
  client.on("msg_sent", (message) => sent.push(message));
  client.on("msg_ignored", (message) => ignored.push(message.reason));

  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      { key: { fromMe: true } },
      { key: { fromMe: true }, message: { messageContextInfo: {} } },
    ],
  });

  assert.deepEqual(sent, []);
  assert.deepEqual(ignored, ["missing_message", "missing_message_type"]);
});

test("checkNumber returns a stable registered-number response", async () => {
  const { calls, client } = await createHarness({
    onWhatsApp: async () => [
      { jid: FICTIONAL_JID, exists: true, lid: FICTIONAL_LID },
    ],
  });

  assert.deepEqual(await client.checkNumber(`+${FICTIONAL_NUMBER}`), {
    jid: FICTIONAL_JID,
    exists: true,
    lid: FICTIONAL_LID,
  });
  assert.deepEqual(calls.onWhatsApp, [FICTIONAL_JID]);
  await client.disconnect();
});

test("checkNumber converts an empty result into exists false", async () => {
  const { client } = await createHarness({ onWhatsApp: async () => [] });

  assert.deepEqual(await client.checkNumber(FICTIONAL_JID), {
    jid: FICTIONAL_JID,
    exists: false,
    lid: null,
  });
  await client.disconnect();
});

test("checkNumber allows registered results without a LID", async () => {
  const { client } = await createHarness({
    onWhatsApp: async () => [{ jid: FICTIONAL_JID, exists: true }],
  });

  assert.deepEqual(await client.checkNumber(FICTIONAL_NUMBER), {
    jid: FICTIONAL_JID,
    exists: true,
    lid: null,
  });
  await client.disconnect();
});

test("checkNumber treats undefined and malformed upstream results as errors", async () => {
  for (const result of [
    undefined,
    null,
    {},
    [{ jid: FICTIONAL_JID, exists: "yes" }],
    [{ jid: "12025550124@s.whatsapp.net", exists: true }],
    [{ jid: FICTIONAL_JID, exists: true, lid: "not a lid" }],
    [
      { jid: FICTIONAL_JID, exists: true },
      { jid: FICTIONAL_JID, exists: true },
    ],
  ]) {
    const { client } = await createHarness({
      onWhatsApp: async () => result,
    });
    await assert.rejects(
      () => client.checkNumber(FICTIONAL_NUMBER),
      WhatsappProtocolError
    );
    await client.disconnect();
  }
});

test("checkNumber rejects groups, LIDs, broadcasts, and device JIDs", async () => {
  const { calls, client } = await createHarness();

  for (const recipient of [
    "120363000000000000@g.us",
    FICTIONAL_LID,
    "status@broadcast",
    `${FICTIONAL_NUMBER}:2@s.whatsapp.net`,
  ]) {
    await assert.rejects(
      () => client.checkNumber(recipient),
      RequestValidationError
    );
  }
  assert.deepEqual(calls.onWhatsApp, []);
  await client.disconnect();
});

test("checkNumber distinguishes disconnected and upstream failures", async () => {
  const disconnected = new WhatsappClient({
    path: "session-test",
    baileys: {},
    autoConnect: false,
    offline: false,
  });
  await assert.rejects(
    () => disconnected.checkNumber(FICTIONAL_NUMBER),
    WhatsappDisconnectedError
  );

  const { client } = await createHarness({
    onWhatsApp: async () => {
      throw new Error(`private upstream text ${FICTIONAL_NUMBER}`);
    },
  });
  await assert.rejects(
    async () => {
      try {
        await client.checkNumber(FICTIONAL_NUMBER);
      } catch (error) {
        assert.ok(error instanceof WhatsappUpstreamError);
        assert.ok(!error.message.includes(FICTIONAL_NUMBER));
        throw error;
      }
    },
    WhatsappUpstreamError
  );
  await client.disconnect();
});

test("bare-number sends check registration while direct JIDs do not", async () => {
  const { calls, client } = await createHarness({
    onWhatsApp: async () => [{ jid: FICTIONAL_JID, exists: true }],
  });

  await client.sendMessage(`+${FICTIONAL_NUMBER}`, { text: "Hello" });
  await client.sendMessage("120363000000000000@g.us", { text: "Hello group" });

  assert.deepEqual(calls.onWhatsApp, [FICTIONAL_JID]);
  assert.equal(calls.sendMessage[0].jid, FICTIONAL_JID);
  assert.equal(calls.sendMessage[1].jid, "120363000000000000@g.us");
  await client.disconnect();
});

test("long-running presence setup awaits its initial update", async () => {
  const { calls, client } = await createHarness();

  await client.setSendPresenceUpdateInterval("available", FICTIONAL_JID);
  assert.deepEqual(calls.sendPresenceUpdate, [
    { type: "available", jid: FICTIONAL_JID },
  ]);
  await client.setSendPresenceUpdateInterval();
  await client.disconnect();
});

test("disconnects expose only bounded reconnect scheduling metadata", async () => {
  const { client, ev } = await createHarness();
  const scheduled = [];
  client.on("reconnect_scheduled", (details) => scheduled.push(details));

  ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { statusCode: 503 } },
  });

  assert.deepEqual(scheduled, [{ attempt: 1, delayMs: 1000 }]);
  await client.disconnect();
});

test("general recipient normalization retains supported direct JIDs", () => {
  assert.equal(normalizeRecipientJid(FICTIONAL_JID), FICTIONAL_JID);
  assert.equal(
    normalizeRecipientJid("120363000000000000@g.us"),
    "120363000000000000@g.us"
  );
  assert.equal(normalizeRecipientJid(FICTIONAL_LID), FICTIONAL_LID);
});

test("retry retrieval preserves own-device messages before HA strips context", async (t) => {
  const { client, ev, calls } = await createHarness({
    decryptionDiagnostics: true,
  });
  t.after(() => client.disconnect());
  const diagnostics = [];
  const sent = [];
  client.on("decryption_diagnostic", (entry) => diagnostics.push(entry));
  client.on("msg_sent", (message) => sent.push(message));
  const key = {
    id: "fictional-synced-id",
    remoteJid: FICTIONAL_LID,
    fromMe: true,
  };
  const message = {
    key,
    message: {
      conversation: "Fictional synced message",
      messageContextInfo: { messageSecret: Buffer.from("fictional context") },
    },
  };
  ev.emit("messages.upsert", { type: "notify", messages: [message] });
  assert.equal(sent[0].message.messageContextInfo, undefined);
  const getMessage = calls.socketOptions[0].getMessage;
  const cached = await getMessage({
    ...key,
    participant: "999999999999999:22@lid",
  });
  assert.equal(cached.conversation, "Fictional synced message");
  assert.equal(
    cached.messageContextInfo.messageSecret.toString(),
    "fictional context"
  );
  ev.emit("messages.upsert", {
    type: "append",
    messages: [{ key, messageStubType: 2 }],
  });
  assert.equal(
    (await getMessage(key)).conversation,
    "Fictional synced message"
  );
  assert.equal(
    await getMessage({ ...key, id: "fictional-missing-id" }),
    undefined
  );
  assert.deepEqual(
    diagnostics
      .filter((entry) => entry.operation === "lookup")
      .map((entry) => entry.hit),
    [true, true, false]
  );
  assert.equal(calls.sendMessage.length, 0);
});

test("successful add-on sends are cached even without an upsert echo", async (t) => {
  const result = {
    key: { id: "fictional-send-id", remoteJid: FICTIONAL_JID, fromMe: true },
    message: { conversation: "Fictional outgoing message" },
  };
  const { client, calls } = await createHarness({
    sendMessage: async () => result,
  });
  t.after(() => client.disconnect());
  const diagnostics = [];
  client.on("decryption_diagnostic", (entry) => diagnostics.push(entry));
  assert.equal(
    await client.sendMessage(FICTIONAL_JID, {
      text: "Fictional outgoing message",
    }),
    result
  );
  assert.equal(
    (await calls.socketOptions[0].getMessage(result.key)).conversation,
    result.message.conversation
  );
  assert.equal(calls.sendMessage.length, 1);
  assert.deepEqual(diagnostics, []);
});

test("the retry cache survives socket replacement but not stop, reset, or logout", async (t) => {
  const { client, ev, calls, baileys } = await createHarness();
  t.after(() => client.disconnect());
  const key = {
    id: "fictional-reconnect-id",
    remoteJid: FICTIONAL_JID,
    fromMe: true,
  };
  ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key, message: { conversation: "Fictional reconnect" } }],
  });
  const oldLookup = calls.socketOptions[0].getMessage;
  await client.disconnect(true);
  const nextSocket = { ev: new EventEmitter(), end: async () => {} };
  baileys.default = (options) => {
    calls.socketOptions.push(options);
    return nextSocket;
  };
  await client.connect();
  // A retry can arrive before connection.open is emitted.
  assert.equal(
    (await calls.socketOptions[1].getMessage(key)).conversation,
    "Fictional reconnect"
  );
  // Stale sockets cannot add content to the active account cache.
  const staleKey = { ...key, id: "fictional-stale-id" };
  ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: staleKey, message: { conversation: "Stale" } }],
  });
  assert.equal(await calls.socketOptions[1].getMessage(staleKey), undefined);
  nextSocket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { statusCode: 401 } },
  });
  assert.equal(await oldLookup(key), undefined);
  assert.equal(await calls.socketOptions[1].getMessage(key), undefined);
  await client.connect();
  nextSocket.ev.emit("messages.upsert", {
    messages: [{ key, message: { conversation: "New account" } }],
  });
  assert.equal(
    (await calls.socketOptions[2].getMessage(key)).conversation,
    "New account"
  );
  await client.disconnect(false);
  assert.equal(await calls.socketOptions[2].getMessage(key), undefined);
});

test("an in-flight send cannot refill a cache after the client stops", async () => {
  let finishSend;
  const { client, calls } = await createHarness({
    sendMessage: () =>
      new Promise((resolve) => {
        finishSend = resolve;
      }),
  });
  const key = {
    id: "fictional-late-send",
    remoteJid: FICTIONAL_JID,
    fromMe: true,
  };
  const pending = client.sendMessage(FICTIONAL_JID, {
    text: "Fictional late send",
  });
  await client.disconnect(false);
  finishSend({ key, message: { conversation: "Fictional late send" } });
  await pending;
  assert.equal(await calls.socketOptions[0].getMessage(key), undefined);
});

test("receipt and acknowledgement diagnostics are opt-in and observational", async (t) => {
  for (const enabled of [false, true]) {
    const { client, ws, calls } = await createHarness({
      decryptionDiagnostics: enabled,
    });
    t.after(() => client.disconnect());
    const entries = [];
    client.on("decryption_diagnostic", (entry) => entries.push(entry));
    const node = {
      tag: "receipt",
      attrs: { id: "fictional-retry", from: FICTIONAL_LID, type: "retry" },
      content: [{ tag: "retry", attrs: { count: "2" } }],
    };
    ws.emit("CB:receipt", node);
    ws.emit("CB:ack,class:message", {
      tag: "ack",
      attrs: { id: "fictional-retry", from: FICTIONAL_LID, class: "message" },
    });
    if (enabled) {
      assert.deepEqual(
        entries.map((entry) => entry.source),
        ["incoming_receipt", "incoming_message_ack"]
      );
      assert.equal(entries[0].rawNode.content[0].attrs.count, "2");
      assert.equal(entries[0].rawNode.attrs.from, FICTIONAL_LID);
    } else {
      assert.equal(ws.listenerCount("CB:receipt"), 0);
      assert.deepEqual(entries, []);
    }
    assert.equal(calls.sendMessage.length, 0);
  }
});

test("diagnostic failures do not interrupt retry retrieval or normal messages", async (t) => {
  const { client, ev, calls } = await createHarness({
    decryptionDiagnostics: true,
  });
  t.after(() => client.disconnect());
  client.on("decryption_diagnostic", () => {
    throw new Error("Fictional diagnostic sink failure");
  });
  const sent = [];
  client.on("msg_sent", (message) => sent.push(message));
  const key = {
    id: "fictional-diagnostic-failure",
    remoteJid: FICTIONAL_JID,
    fromMe: true,
  };
  ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key, message: { conversation: "Fictional text" } }],
  });
  assert.equal(sent.length, 1);
  assert.equal(
    (await calls.socketOptions[0].getMessage(key)).conversation,
    "Fictional text"
  );
});

const fictionalGroupMetadata = () => ({
  id: FICTIONAL_GROUP_JID,
  addressingMode: "lid",
  subject: "Fictional Family",
  subjectOwner: FICTIONAL_LID,
  subjectOwnerJid: FICTIONAL_JID,
  subjectTime: 1700000000,
  size: 3,
  creation: 1681809164,
  owner: FICTIONAL_LID,
  ownerJid: FICTIONAL_JID,
  desc: "Weekend plans",
  descId: "fictional-desc-id",
  linkedParent: "120363000000000001@g.us",
  restrict: true,
  announce: false,
  isCommunity: false,
  isCommunityAnnounce: false,
  joinApprovalMode: false,
  memberAddMode: true,
  participants: [
    { id: FICTIONAL_LID, jid: FICTIONAL_JID, lid: FICTIONAL_LID, admin: "superadmin" },
    { id: "888888888888888@lid", jid: "12025550199@s.whatsapp.net", lid: "888888888888888@lid", admin: "admin" },
    { id: "777777777777777@lid", jid: "12025550177@s.whatsapp.net", lid: "777777777777777@lid", admin: null },
  ],
  ephemeralDuration: 604800,
});

test("getGroupInfo reduces Baileys group metadata to the stable response", async () => {
  const { calls, client } = await createHarness({
    groupMetadata: async () => fictionalGroupMetadata(),
  });

  assert.deepEqual(await client.getGroupInfo(FICTIONAL_GROUP_JID), {
    jid: FICTIONAL_GROUP_JID,
    subject: "Fictional Family",
    description: "Weekend plans",
    owner: FICTIONAL_JID,
    created_at: "2023-04-18T09:12:44.000Z",
    size: 3,
    announce_only: false,
    admins_only_settings: true,
    is_community: false,
    parent_community: "120363000000000001@g.us",
    participants: [
      { jid: FICTIONAL_JID, lid: FICTIONAL_LID, admin: "superadmin" },
      { jid: "12025550199@s.whatsapp.net", lid: "888888888888888@lid", admin: "admin" },
      { jid: "12025550177@s.whatsapp.net", lid: "777777777777777@lid", admin: null },
    ],
  });
  assert.deepEqual(calls.groupMetadata, [FICTIONAL_GROUP_JID]);
  await client.disconnect();
});

test("getGroupInfo degrades missing or unexpected optional metadata to null", async () => {
  const { client } = await createHarness({
    groupMetadata: async () => ({
      id: FICTIONAL_GROUP_JID,
      subject: "",
      owner: FICTIONAL_LID,
      creation: Number.NaN,
      size: "3",
      participants: [
        // Baileys yields "" when WhatsApp omits phone_number for a LID member.
        { id: FICTIONAL_LID, jid: "", lid: FICTIONAL_LID, admin: "owner" },
        { id: "12025550199@s.whatsapp.net", jid: "12025550199@s.whatsapp.net" },
        { id: "123@hosted", jid: "", lid: undefined, admin: undefined },
      ],
    }),
  });

  assert.deepEqual(await client.getGroupInfo(FICTIONAL_GROUP_JID), {
    jid: FICTIONAL_GROUP_JID,
    subject: "",
    description: null,
    owner: FICTIONAL_LID,
    created_at: null,
    size: 3,
    announce_only: false,
    admins_only_settings: false,
    is_community: false,
    parent_community: null,
    participants: [
      { jid: null, lid: FICTIONAL_LID, admin: null },
      { jid: "12025550199@s.whatsapp.net", lid: null, admin: null },
      { jid: null, lid: null, admin: null },
    ],
  });
  await client.disconnect();
});

test("getGroupInfo treats malformed upstream metadata as a protocol error", async () => {
  for (const metadata of [
    undefined,
    null,
    [],
    {},
    { ...fictionalGroupMetadata(), id: "120363000000000009@g.us" },
    { ...fictionalGroupMetadata(), subject: undefined },
    { ...fictionalGroupMetadata(), subject: 42 },
    { ...fictionalGroupMetadata(), desc: 42 },
    { ...fictionalGroupMetadata(), participants: {} },
    { ...fictionalGroupMetadata(), participants: ["participant"] },
  ]) {
    const { client } = await createHarness({
      groupMetadata: async () => metadata,
    });
    await assert.rejects(
      client.getGroupInfo(FICTIONAL_GROUP_JID),
      WhatsappProtocolError
    );
    await client.disconnect();
  }
});

test("getGroupInfo rejects non-group targets before calling Baileys", async () => {
  const { calls, client } = await createHarness({
    groupMetadata: async () => fictionalGroupMetadata(),
  });

  for (const target of [
    FICTIONAL_JID,
    FICTIONAL_NUMBER,
    FICTIONAL_LID,
    "120363000000000000",
    "status@broadcast",
    ` ${FICTIONAL_GROUP_JID}`,
    "",
    undefined,
  ]) {
    await assert.rejects(client.getGroupInfo(target), RequestValidationError);
  }
  assert.deepEqual(calls.groupMetadata, []);
  await client.disconnect();
});

test("getGroupInfo maps upstream failures and disconnected sessions", async () => {
  const { client } = await createHarness({
    groupMetadata: async () => {
      const error = new Error("forbidden");
      error.output = { statusCode: 403 };
      throw error;
    },
  });

  await assert.rejects(client.getGroupInfo(FICTIONAL_GROUP_JID), (error) => {
    assert.ok(error instanceof WhatsappUpstreamError);
    assert.equal(error.upstreamCode, 403);
    assert.ok(!error.message.includes("forbidden"));
    return true;
  });

  await client.disconnect();
  await assert.rejects(
    client.getGroupInfo(FICTIONAL_GROUP_JID),
    WhatsappDisconnectedError
  );
});

// Issue #7, 23 Sep: Baileys 6.7.23 held every messages.upsert of a backlog that
// WhatsApp never finished, so nothing reached Home Assistant for 50 minutes.
test("events held by Baileys reach Home Assistant once the connection is open", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let buffering = true;
  const held = [];
  const { client } = await createHarness({
    configureSocket: (socket) => {
      socket.ev.isBuffering = () => buffering;
      socket.ev.flush = () => {
        if (!buffering) return false;
        buffering = false;
        for (const upsert of held.splice(0)) socket.ev.emit("messages.upsert", upsert);
        return true;
      };
    },
  });
  t.after(() => client.disconnect());
  const received = [];
  const released = [];
  client.on("msg", (message) => received.push(message));
  client.on("events_released", () => released.push(true));
  held.push({ type: "append", messages: [{
    key: { id: "fictional-held-id", remoteJid: FICTIONAL_LID, fromMe: false },
    message: { conversation: "Fictional held message" },
  }] });

  t.mock.timers.tick(1000);
  assert.deepEqual(received, []);
  t.mock.timers.tick(1000);
  assert.equal(received.length, 1);
  assert.equal(received[0].message.conversation, "Fictional held message");
  assert.equal(released.length, 1);

  // Stopping the client also stops the watchdog.
  await client.disconnect();
  buffering = true;
  t.mock.timers.tick(5000);
  assert.equal(released.length, 1);
});

test("offline backlog reports come from the current socket until it stops", async () => {
  const { client, ws } = await createHarness();
  const reports = [];
  client.on("offline_sync", (report) => reports.push(report));
  ws.emit("frame", { tag: "message", attrs: { id: "fictional-id", offline: "0" } });
  ws.emit("frame", { tag: "ib", attrs: {}, content: [{ tag: "offline", attrs: { count: "1" } }] });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].phase, "finished");
  assert.equal(reports[0].count, 1);
  assert.equal(reports[0].received.message, 1);
  assert.doesNotMatch(JSON.stringify(reports), /fictional/);

  await client.disconnect();
  assert.equal(ws.listenerCount("frame"), 0);
  ws.emit("frame", { tag: "ib", attrs: {}, content: [{ tag: "offline", attrs: { count: "1" } }] });
  assert.equal(reports.length, 1);
});

const FICTIONAL_CALL_ID = "0123456789ABCDEF0123456789ABCDEF";

test("rejectCall forwards the call event fields to Baileys", async (t) => {
  const rejected = [];
  const { client } = await createHarness({
    configureSocket: (socket) => {
      socket.rejectCall = async (...args) => rejected.push(args);
    },
  });
  t.after(() => client.disconnect());

  const declined = [];
  client.on("call_rejected", (event) => declined.push(event));
  await client.rejectCall(FICTIONAL_CALL_ID, FICTIONAL_LID);
  await client.rejectCall(FICTIONAL_CALL_ID, FICTIONAL_JID);
  assert.deepEqual(declined, [
    { callId: FICTIONAL_CALL_ID },
    { callId: FICTIONAL_CALL_ID },
  ]);
  assert.deepEqual(rejected, [
    [FICTIONAL_CALL_ID, FICTIONAL_LID],
    [FICTIONAL_CALL_ID, FICTIONAL_JID],
  ]);

  for (const [callId, from] of [
    ["bad id", FICTIONAL_LID],
    [FICTIONAL_CALL_ID, FICTIONAL_GROUP_JID],
    [FICTIONAL_CALL_ID, FICTIONAL_NUMBER],
  ]) {
    await assert.rejects(client.rejectCall(callId, from), RequestValidationError);
  }
  assert.equal(rejected.length, 2);
});

test("rejectCall maps upstream failures, timeouts and disconnected sessions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let behavior = "fail";
  const { client } = await createHarness({
    configureSocket: (socket) => {
      socket.rejectCall = async () => {
        if (behavior === "fail") {
          const error = new Error("forbidden");
          error.output = { statusCode: 403 };
          throw error;
        }
        return new Promise(() => {});
      };
    },
  });

  await assert.rejects(client.rejectCall(FICTIONAL_CALL_ID, FICTIONAL_LID), (error) => {
    assert.ok(error instanceof WhatsappUpstreamError);
    assert.equal(error.upstreamCode, 403);
    assert.ok(!error.message.includes("forbidden"));
    return true;
  });

  behavior = "hang";
  const pending = client.rejectCall(FICTIONAL_CALL_ID, FICTIONAL_LID);
  t.mock.timers.tick(8_000);
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof WhatsappUpstreamError);
    assert.equal(error.upstreamCode, 408);
    return true;
  });

  await client.disconnect();
  await assert.rejects(
    client.rejectCall(FICTIONAL_CALL_ID, FICTIONAL_LID),
    WhatsappDisconnectedError
  );
});

test("rejectCall treats a socket without call support as a protocol error", async (t) => {
  const { client } = await createHarness();
  t.after(() => client.disconnect());
  await assert.rejects(
    client.rejectCall(FICTIONAL_CALL_ID, FICTIONAL_LID),
    WhatsappProtocolError
  );
});

test("app-state sync notifications and decoded changes are reported, then detached", async () => {
  const events = [];
  const { calls, client, ws } = await createHarness({
    account: "999999999999991:4@s.whatsapp.net",
  });
  client.on("app_state_sync", (event) => events.push(event));
  const { logger } = calls.socketOptions[0];

  ws.emit("frame", {
    tag: "notification",
    attrs: { type: "server_sync", from: "s.whatsapp.net" },
    content: [{ tag: "collection", attrs: { name: "regular_low", version: "9" } }],
  });
  const mutation = { index: ["call", FICTIONAL_CALL_ID], syncAction: { value: {} } };
  logger.trace({ syncAction: mutation, initialSync: false }, "processing sync action");
  logger.info("synced regular_low to v10");

  assert.deepEqual(events, [
    { type: "server_sync", collections: ["regular_low"] },
    {
      type: "action",
      mutation,
      initialSync: false,
      self: { id: "999999999999991:4@s.whatsapp.net", lid: undefined },
    },
    { type: "resync", phase: "synced", collection: "regular_low", version: 10 },
  ]);

  await client.disconnect();
  ws.emit("frame", {
    tag: "notification",
    attrs: { type: "server_sync" },
    content: [{ tag: "collection", attrs: { name: "regular" } }],
  });
  assert.equal(events.length, 3);
});

const upstreamError = (code) =>
  Object.assign(new Error(`fictional ${code}`), { output: { statusCode: code } });

test("getProfile combines picture, about text and business profile", async (t) => {
  const queried = [];
  const { client } = await createHarness({
    configureSocket: (socket) => {
      socket.profilePictureUrl = async (jid, type) => {
        queried.push(["picture", jid, type]);
        return "https://pps.whatsapp.net/fictional.jpg";
      };
      socket.fetchStatus = async (jid) => {
        queried.push(["about", jid]);
        return [{ id: jid, status: { status: "Busy", setAt: new Date("2026-09-01T10:00:00Z") } }];
      };
      socket.getBusinessProfile = async () => ({
        wid: FICTIONAL_JID,
        description: "Fictional bakery",
        category: "Bakery",
        email: undefined,
        website: ["https://example.com", 42],
        address: "1 Main St",
        business_hours: {},
      });
    },
  });
  t.after(() => client.disconnect());

  assert.deepEqual(await client.getProfile(`+${FICTIONAL_NUMBER}`), {
    jid: FICTIONAL_JID,
    picture_url: "https://pps.whatsapp.net/fictional.jpg",
    about: "Busy",
    about_set_at: "2026-09-01T10:00:00.000Z",
    business: {
      description: "Fictional bakery",
      category: "Bakery",
      email: null,
      website: ["https://example.com"],
      address: "1 Main St",
    },
  });
  assert.deepEqual(queried, [
    ["picture", FICTIONAL_JID, "image"],
    ["about", FICTIONAL_JID],
  ]);

  queried.length = 0;
  const group = await client.getProfile(FICTIONAL_GROUP_JID);
  assert.deepEqual(group, {
    jid: FICTIONAL_GROUP_JID,
    picture_url: "https://pps.whatsapp.net/fictional.jpg",
    about: null,
    about_set_at: null,
    business: null,
  });
  assert.deepEqual(queried, [["picture", FICTIONAL_GROUP_JID, "image"]]);

  for (const target of ["status@broadcast", `${FICTIONAL_NUMBER}:3@s.whatsapp.net`, ""]) {
    await assert.rejects(client.getProfile(target), RequestValidationError);
  }
});

test("getProfile returns null for hidden data and fails on other errors", async (t) => {
  let pictureError = 401;
  const { client } = await createHarness({
    configureSocket: (socket) => {
      socket.profilePictureUrl = async () => {
        throw upstreamError(pictureError);
      };
      socket.fetchStatus = async (jid) => [{ id: jid, status: { status: null, setAt: new Date(0) } }];
      socket.getBusinessProfile = async () => {
        throw upstreamError(404);
      };
    },
  });

  assert.deepEqual(await client.getProfile(FICTIONAL_LID), {
    jid: FICTIONAL_LID,
    picture_url: null,
    about: null,
    about_set_at: null,
    business: null,
  });

  pictureError = 500;
  await assert.rejects(client.getProfile(FICTIONAL_LID), (error) => {
    assert.ok(error instanceof WhatsappUpstreamError);
    assert.equal(error.upstreamCode, 500);
    assert.ok(!error.message.includes("fictional"));
    return true;
  });

  await client.disconnect();
  await assert.rejects(client.getProfile(FICTIONAL_LID), WhatsappDisconnectedError);
});

test("listGroups returns every group without members, sorted by name", async (t) => {
  const metadata = (id, subject, extra = {}) => ({
    id,
    subject,
    owner: FICTIONAL_JID,
    creation: 1681809164,
    size: 2,
    participants: [{ id: FICTIONAL_JID, jid: FICTIONAL_JID, admin: "superadmin" }],
    ...extra,
  });
  const { client } = await createHarness({
    configureSocket: (socket) => {
      socket.groupFetchAllParticipating = async () => ({
        "120363000000000002@g.us": metadata("120363000000000002@g.us", "Zoo"),
        "120363000000000001@g.us": metadata("120363000000000001@g.us", "Family", {
          announce: true,
          desc: "Weekend plans",
        }),
        "120363000000000003@g.us": { id: "120363000000000003@g.us" },
        "not-a-group": metadata("not-a-group", "Broken"),
      });
    },
  });
  t.after(() => client.disconnect());

  const groups = await client.listGroups();
  assert.deepEqual(groups.map(({ jid, subject }) => [jid, subject]), [
    ["120363000000000001@g.us", "Family"],
    ["120363000000000002@g.us", "Zoo"],
  ]);
  assert.deepEqual(groups[0], {
    jid: "120363000000000001@g.us",
    subject: "Family",
    description: "Weekend plans",
    owner: FICTIONAL_JID,
    created_at: "2023-04-18T09:12:44.000Z",
    size: 2,
    announce_only: true,
    admins_only_settings: false,
    is_community: false,
    parent_community: null,
  });
});

test("listGroups maps malformed and failed responses to upstream errors", async () => {
  let response = null;
  const { client } = await createHarness({
    configureSocket: (socket) => {
      socket.groupFetchAllParticipating = async () => {
        if (response instanceof Error) throw response;
        return response;
      };
    },
  });
  await assert.rejects(client.listGroups(), WhatsappProtocolError);
  response = upstreamError(500);
  await assert.rejects(client.listGroups(), WhatsappUpstreamError);
  await client.disconnect();
  await assert.rejects(client.listGroups(), WhatsappDisconnectedError);
});

test("receipts become message status and chat read events", async (t) => {
  const { client, ev } = await createHarness({
    configureSocket: (socket) => {
      socket.authState = { creds: { me: { id: "12025550100:4@s.whatsapp.net", lid: "999999999999991:4@lid" } } };
    },
  });
  t.after(() => client.disconnect());
  const statuses = [];
  const reads = [];
  client.on("message_status", (status) => statuses.push(status));
  client.on("chat_read", (read) => reads.push(read));

  ev.emit("messages.update", [
    { key: { remoteJid: FICTIONAL_LID, id: "3EB0SENT", fromMe: true }, update: { status: 4 } },
    { key: { remoteJid: FICTIONAL_LID, id: "3EB0INCOMING", fromMe: false }, update: { status: 4 } },
  ]);
  ev.emit("message-receipt.update", [
    {
      key: { remoteJid: FICTIONAL_GROUP_JID, id: "3EB0GROUP", fromMe: false },
      receipt: { userJid: "999999999999991@lid", readTimestamp: 1790840180 },
    },
  ]);
  ev.emit("messages.update", "malformed");

  assert.deepEqual(statuses, [{
    chatId: FICTIONAL_LID,
    messageId: "3EB0SENT",
    status: "read",
    participant: null,
    timestamp: null,
  }]);
  assert.deepEqual(reads, [
    { chatId: FICTIONAL_LID, status: "read", messageIds: ["3EB0INCOMING"] },
    { chatId: FICTIONAL_GROUP_JID, status: "read", messageIds: ["3EB0GROUP"] },
  ]);
});

const POLL_OPTIONS = ["Daily report", "Weekly report"];
// The client strips the secret from a poll it has processed, as it does for
// Home Assistant, so the voters' copy is kept here.
const POLL_SECRETS = new WeakMap();
const fictionalPoll = (id, key, secret = require("node:crypto").randomBytes(32)) => {
  const poll = {
    key: { id, remoteJid: FICTIONAL_GROUP_JID, ...key },
    message: {
      pollCreationMessage: {
        name: "Which report would you like?",
        options: POLL_OPTIONS.map((optionName) => ({ optionName })),
      },
      messageContextInfo: { messageSecret: Buffer.from(secret) },
    },
  };
  POLL_SECRETS.set(poll, secret);
  return poll;
};
// The same poll as WhatsApp would deliver it again, secret included.
const redelivered = (poll) => fictionalPoll(poll.key.id, poll.key, POLL_SECRETS.get(poll));

// Encrypts a vote the way a voter's phone does, independently of Baileys.
const fictionalVote = async (id, poll, { creator, voter, selected }) => {
  const crypto = require("node:crypto");
  const { proto } = await import("@whiskeysockets/baileys");
  const secret = POLL_SECRETS.get(poll);
  const info = Buffer.concat([poll.key.id, creator, voter, "Poll Vote"].map((part) => Buffer.from(part)));
  const encIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm",
    Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(32), info, 32)), encIv);
  cipher.setAAD(Buffer.from(`${poll.key.id}\u0000${voter}`));
  const plain = proto.Message.PollVoteMessage.encode({
    selectedOptions: selected.map((name) => crypto.createHash("sha256").update(name).digest()),
  }).finish();
  return {
    key: { id, remoteJid: FICTIONAL_GROUP_JID, fromMe: false, participant: voter },
    message: { pollUpdateMessage: {
      pollCreationMessageKey: { id: poll.key.id, remoteJid: FICTIONAL_GROUP_JID, fromMe: poll.key.fromMe,
        ...(poll.key.participant ? { participant: poll.key.participant } : {}) },
      vote: { encPayload: Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]), encIv },
    } },
  };
};

test("poll votes reach Home Assistant decoded and the poll secret never does", async (t) => {
  const poll = fictionalPoll("fictional-poll-id", { fromMe: true });
  const { client, ev } = await createHarness({
    sendMessage: async () => poll,
    configureSocket: (socket) => {
      socket.authState = { creds: { me: { id: "12025550100:4@s.whatsapp.net", lid: "999999999999991:4@lid" } } };
    },
  });
  t.after(() => client.disconnect());
  const requests = [];
  createAddonRuntime({ clientIds: ["default"], clientFactory: () => client,
    logger: {}, httpClient: { post: async (...args) => requests.push(args) } });
  const votes = [
    await fictionalVote("fictional-vote-1", poll,
      { creator: "999999999999991@lid", voter: FICTIONAL_LID, selected: ["Weekly report"] }),
    await fictionalVote("fictional-vote-2", poll, { creator: "999999999999991@lid", voter: FICTIONAL_LID, selected: [] }),
    await fictionalVote("fictional-vote-3", fictionalPoll("fictional-unseen-id", { fromMe: true }),
      { creator: "999999999999991@lid", voter: FICTIONAL_LID, selected: ["Daily report"] }),
  ];

  // The poll is remembered from the send itself, before WhatsApp echoes it.
  await client.sendMessage(FICTIONAL_GROUP_JID, { poll: { name: "Fictional", values: POLL_OPTIONS } });
  ev.emit("messages.upsert", { type: "notify", messages: [votes[0]] });
  ev.emit("messages.upsert", { type: "append", messages: [poll] });
  ev.emit("messages.upsert", { type: "notify", messages: [votes[1], votes[2], {
    key: { id: "fictional-text-id", remoteJid: FICTIONAL_GROUP_JID, fromMe: false, participant: FICTIONAL_LID },
    message: { conversation: "Fictional text" },
  }] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests.map(([url, body]) => [url.split("/").pop(), body.type, body.poll_vote]), [
    ["new_whatsapp_message", "pollUpdateMessage", { status: "ready", poll_id: "fictional-poll-id",
      poll_name: "Which report would you like?", selected_options: ["Weekly report"] }],
    ["whatsapp_message_sent", "pollCreationMessage", undefined],
    ["new_whatsapp_message", "pollUpdateMessage", { status: "ready", poll_id: "fictional-poll-id",
      poll_name: "Which report would you like?", selected_options: [] }],
    ["new_whatsapp_message", "pollUpdateMessage",
      { status: "error", error: "unknown_poll", poll_id: "fictional-unseen-id" }],
    ["new_whatsapp_message", "conversation", undefined],
  ]);
  assert.equal(requests.some(([, body]) => "poll_vote" in body && !body.poll_vote), false);
  assert.equal(JSON.stringify(requests).includes("messageSecret"), false);
  // The encrypted vote itself is still passed through unchanged.
  assert.ok(requests[0][1].message.pollUpdateMessage.vote.encPayload);
});

test("wrapped polls and votes reach Home Assistant without their nested secrets", async (t) => {
  const { client, ev } = await createHarness();
  t.after(() => client.disconnect());
  const requests = [];
  createAddonRuntime({ clientIds: ["default"], clientFactory: () => client,
    logger: {}, httpClient: { post: async (...args) => requests.push(args) } });

  for (const wrapper of ["ephemeralMessage", "viewOnceMessageV2", "pollCreationMessageV5"]) {
    const poll = fictionalPoll(`fictional-wrapped-poll-${wrapper}`, { fromMe: false, participant: FICTIONAL_JID });
    const vote = await fictionalVote(`fictional-wrapped-vote-${wrapper}`, poll,
      { creator: FICTIONAL_JID, voter: FICTIONAL_LID, selected: ["Weekly report"] });
    ev.emit("messages.upsert", { type: "notify", messages: [
      { key: poll.key, message: { [wrapper]: { message: poll.message } } },
      { key: vote.key, message: { ephemeralMessage: { message: vote.message } } },
    ] });
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 6);
  assert.equal(JSON.stringify(requests).includes("messageSecret"), false);
  for (const index of [1, 3, 5]) {
    assert.equal(requests[index][1].type, "pollUpdateMessage");
    assert.equal(requests[index][1].poll_vote.status, "ready");
    assert.deepEqual(requests[index][1].poll_vote.selected_options, ["Weekly report"]);
  }
});

test("sent poll results omit secrets while keeping them available for vote decoding and retries", async (t) => {
  const poll = fictionalPoll("fictional-send-result-poll", { fromMe: true });
  const { client, calls, ev } = await createHarness({
    sendMessage: async () => poll,
    configureSocket: (socket) => {
      socket.authState = { creds: { me: { id: "12025550100:4@s.whatsapp.net" } } };
    },
  });
  t.after(() => client.disconnect());
  const vote = await fictionalVote("fictional-send-result-vote", poll,
    { creator: "12025550100@s.whatsapp.net", voter: FICTIONAL_LID, selected: ["Weekly report"] });
  const result = await client.sendMessage(FICTIONAL_GROUP_JID,
    { poll: { name: "Which report would you like?", values: POLL_OPTIONS } });
  assert.equal(result.key.id, poll.key.id);
  assert.equal(JSON.stringify(result).includes("messageSecret"), false);
  const cached = await calls.socketOptions[0].getMessage(poll.key);
  assert.ok(cached.messageContextInfo.messageSecret);
  const received = [];
  client.on("msg", (message) => received.push(message));
  ev.emit("messages.upsert", { type: "notify", messages: [vote] });
  assert.deepEqual(received[0].poll_vote.selected_options, ["Weekly report"]);
});

test("remembered polls decode votes after a restart and are forgotten on logout", async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const sessionPath = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-poll-client-"));
  t.after(() => fs.rm(sessionPath, { recursive: true, force: true }));
  const settings = { sessionPath, account: "12025550125:1@s.whatsapp.net" };
  const poll = fictionalPoll("fictional-poll-id", { fromMe: false, participant: FICTIONAL_JID });
  const late = fictionalPoll("fictional-late-id", { fromMe: false, participant: FICTIONAL_JID });
  const first = await createHarness(settings);
  first.ev.emit("messages.upsert", { type: "notify", messages: [poll] });
  await first.client.disconnect();
  // Retired sockets cannot repopulate the saved polls.
  first.ev.emit("messages.upsert", { type: "notify", messages: [redelivered(late)] });
  await first.client.disconnect();

  const received = [];
  const collect = (message) => {
    if (message.type === "pollUpdateMessage") received.push(message.poll_vote);
  };
  const vote = async (harness, id, target) => {
    harness.ev.emit("messages.upsert", { type: "notify", messages: [await fictionalVote(id, target,
      { creator: FICTIONAL_JID, voter: FICTIONAL_LID, selected: POLL_OPTIONS })] });
  };
  const second = await createHarness(settings);
  second.client.on("msg", collect);
  await vote(second, "fictional-vote-1", poll);
  await vote(second, "fictional-vote-2", late);
  second.ev.emit("connection.update", { connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } } });
  second.ev.emit("messages.upsert", { type: "notify", messages: [redelivered(late)] });
  await second.client.disconnect();
  const third = await createHarness(settings);
  third.client.on("msg", collect);
  await vote(third, "fictional-vote-3", poll);
  await vote(third, "fictional-vote-4", late);
  await third.client.disconnect();

  assert.deepEqual(received, [
    { status: "ready", poll_id: "fictional-poll-id", poll_name: "Which report would you like?",
      selected_options: POLL_OPTIONS },
    { status: "error", error: "unknown_poll", poll_id: "fictional-late-id" },
    { status: "error", error: "unknown_poll", poll_id: "fictional-poll-id" },
    { status: "error", error: "unknown_poll", poll_id: "fictional-late-id" },
  ]);
});

/** Emit a fictional message with distinct account-owner and sender profile names. */
const emitContactMessage = (ev, { id = "contact-message", jid = FICTIONAL_LID, fromMe = true } = {}) => {
  ev.emit("messages.upsert", { type: "notify", messages: [{
    key: { id, remoteJid: jid, fromMe }, pushName: fromMe ? "Account owner" : "Sender profile",
    message: { conversation: "Fictional text" },
  }] });
};

test("outgoing Home Assistant events include the saved recipient name and PN/LID aliases", async (t) => {
  const { client, ev } = await createHarness();
  t.after(() => client.disconnect());
  const requests = [];
  createAddonRuntime({ clientIds: ["default"], clientFactory: () => client,
    logger: {}, httpClient: { post: async (...args) => requests.push(args) } });
  ev.emit("messaging-history.set", { contacts: [{ id: FICTIONAL_JID, lid: FICTIONAL_LID,
    name: "Recipient Example", notify: "Recipient profile" }], messages: [] });
  ev.emit("contacts.update", [{ id: FICTIONAL_LID, notify: "New profile" }]);
  emitContactMessage(ev);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(requests[0][0].endsWith("/whatsapp_message_sent"));
  assert.equal(requests[0][1].recipient_name, "Recipient Example");
  assert.deepEqual(requests[0][1].recipient_identifiers, [FICTIONAL_JID, FICTIONAL_LID]);
  assert.equal(requests[0][1].pushName, "Account owner");
});

test("unknown outgoing recipients never use own pushName and incoming events keep their fields", async (t) => {
  const { client, ev } = await createHarness();
  t.after(() => client.disconnect());
  const sent = [];
  const incoming = [];
  client.on("msg_sent", (message) => sent.push(message));
  client.on("msg", (message) => incoming.push(message));
  emitContactMessage(ev);
  ev.emit("contacts.upsert", [{ id: FICTIONAL_LID, notify: "Recipient profile" }]);
  emitContactMessage(ev, { id: "known-recipient" });
  emitContactMessage(ev, { id: "incoming-contact", fromMe: false });
  assert.equal(sent[0].recipient_name, null);
  assert.deepEqual(sent[0].recipient_identifiers, []);
  assert.equal(sent[1].recipient_name, "Recipient profile");
  assert.equal(Object.hasOwn(incoming[0], "recipient_name"), false);
  assert.equal(Object.hasOwn(incoming[0], "recipient_identifiers"), false);
  assert.equal(incoming[0].pushName, "Sender profile");
});

test("group sends never expose a member name or enumerate group participants", async (t) => {
  let queries = 0;
  const { client, ev, calls } = await createHarness({ account: "12025550125@s.whatsapp.net",
    authKeys: { get: async () => ({}) },
    configureSocket: (socket) => { socket.query = async () => { queries += 1; }; } });
  t.after(() => client.disconnect());
  const sent = [];
  client.on("msg_sent", (message) => sent.push(message));
  ev.emit("contacts.upsert", [{ id: FICTIONAL_JID, lid: FICTIONAL_LID, name: "Group member" }]);
  emitContactMessage(ev, { jid: FICTIONAL_GROUP_JID });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].recipient_name, null);
  assert.deepEqual(sent[0].recipient_identifiers, []);
  assert.equal(queries, 0);
  assert.deepEqual(calls.groupMetadata, []);
});

test("recipient metadata persists between clients and retired sockets cannot change it", async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const sessionPath = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-recipient-client-"));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.disconnect();
    await fs.rm(sessionPath, { recursive: true, force: true });
  });
  const settings = { sessionPath, account: "12025550125:1@s.whatsapp.net" };
  const first = await createHarness(settings);
  clients.push(first.client);
  first.ev.emit("contacts.upsert", [{ id: FICTIONAL_JID, lid: FICTIONAL_LID, name: "Recipient Example" }]);
  await first.client.disconnect();
  first.ev.emit("contacts.update", [{ id: FICTIONAL_JID, name: "Retired socket" }]);
  const second = await createHarness(settings);
  clients.push(second.client);
  const sent = [];
  second.client.on("msg_sent", (message) => sent.push(message));
  emitContactMessage(second.ev);
  assert.equal(sent[0].recipient_name, "Recipient Example");
  second.ev.emit("connection.update", { connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } } });
  second.ev.emit("contacts.update", [{ id: FICTIONAL_JID, name: "Logged out" }]);
  await second.client.disconnect();
  const third = await createHarness(settings);
  clients.push(third.client);
  third.client.on("msg_sent", (message) => sent.push(message));
  emitContactMessage(third.ev);
  assert.equal(sent[1].recipient_name, null);
});

test("outgoing events resolve missing names from current verified contact metadata", async (t) => {
  const baileys = await import("@whiskeysockets/baileys");
  const keyId = Buffer.from("fictional-key").toString("base64");
  const key = { keyData: Buffer.alloc(32, 7) };
  const { patch, state } = await baileys.encodeSyncdPatch({ type: "critical_unblock_low",
    index: ["contact", FICTIONAL_JID], syncAction: { contactAction: { fullName: "Recipient Example",
      lidJid: FICTIONAL_LID } }, apiVersion: 2, operation: baileys.proto.SyncdMutation.SyncdOperation.SET },
  keyId, baileys.newLTHashState(), async () => key);
  const snapshot = { version: { version: state.version }, keyId: patch.keyId,
    mac: patch.snapshotMac, records: patch.mutations.map((mutation) => mutation.record) };
  let queries = 0;
  const { client, ev } = await createHarness({ account: "12025550125@s.whatsapp.net",
    authKeys: { get: async (_kind, ids) => Object.fromEntries(ids.map((id) => [id, key])),
      set() { throw new Error("Must not modify authentication"); } },
    baileysOverrides: { newLTHashState: baileys.newLTHashState,
      decodeSyncdSnapshot: baileys.decodeSyncdSnapshot, decodePatches: baileys.decodePatches,
      extractSyncdPatches: async () => ({ critical_unblock_low: { snapshot, patches: [] } }) },
    configureSocket: (socket) => { socket.query = async () => { queries += 1; return {}; }; } });
  t.after(() => client.disconnect());
  const sent = [];
  client.on("msg_sent", (message) => sent.push(message));
  const delivered = once(client, "msg_sent");
  emitContactMessage(ev);
  await delivered;
  assert.equal(sent[0].recipient_name, "Recipient Example");
  assert.deepEqual(sent[0].recipient_identifiers, [FICTIONAL_JID, FICTIONAL_LID]);
  emitContactMessage(ev, { id: "cached-recipient" });
  assert.equal(sent.length, 2);
  assert.equal(queries, 1);
});

test("failed contact lookup still forwards the sent event with no recipient name", async (t) => {
  const baileys = await import("@whiskeysockets/baileys");
  let queries = 0;
  const { client, ev } = await createHarness({ account: "12025550125@s.whatsapp.net",
    authKeys: { get: async () => ({}) }, baileysOverrides: {
      newLTHashState: baileys.newLTHashState, decodeSyncdSnapshot: baileys.decodeSyncdSnapshot,
      decodePatches: baileys.decodePatches, extractSyncdPatches: baileys.extractSyncdPatches },
    configureSocket: (socket) => { socket.query = async () => {
      queries += 1; throw new Error("Fictional private failure");
    }; } });
  t.after(() => client.disconnect());
  const sent = [];
  client.on("msg_sent", (message) => sent.push(message));
  emitContactMessage(ev);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].recipient_name, null);
  assert.equal(sent[0].pushName, "Account owner");
  emitContactMessage(ev, { id: "second-unknown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.equal(queries, 1);
});


test("disconnect during recipient lookup keeps the observed sent event and its archive state", async (t) => {
  const baileys = await import("@whiskeysockets/baileys");
  let release;
  const { client, ev } = await createHarness({ account: "12025550125@s.whatsapp.net",
    authKeys: { get: async () => ({}) }, baileysOverrides: {
      newLTHashState: baileys.newLTHashState, decodeSyncdSnapshot: baileys.decodeSyncdSnapshot,
      decodePatches: baileys.decodePatches, extractSyncdPatches: async () => ({}) },
    configureSocket: (socket) => { socket.query = () => new Promise((resolve) => { release = resolve; }); } });
  t.after(() => client.disconnect());
  ev.emit("chats.update", [{ id: FICTIONAL_LID, archived: true }]);
  const delivered = once(client, "msg_sent");
  emitContactMessage(ev);
  ev.emit("connection.update", { connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } } });
  release({});
  const [message] = await delivered;
  assert.equal(message.recipient_name, null);
  assert.equal(message.chat_archived, true);
});


test("archive updates received during a name lookup are reflected in the sent event", async (t) => {
  const baileys = await import("@whiskeysockets/baileys");
  let release;
  const { client, ev } = await createHarness({ account: "12025550125@s.whatsapp.net",
    authKeys: { get: async () => ({}) }, baileysOverrides: {
      newLTHashState: baileys.newLTHashState, decodeSyncdSnapshot: baileys.decodeSyncdSnapshot,
      decodePatches: baileys.decodePatches, extractSyncdPatches: async () => ({}) },
    configureSocket: (socket) => { socket.query = () => new Promise((resolve) => { release = resolve; }); } });
  t.after(() => client.disconnect());
  ev.emit("chats.update", [{ id: FICTIONAL_LID, archived: false }]);
  const delivered = once(client, "msg_sent");
  emitContactMessage(ev);
  ev.emit("chats.update", [{ id: FICTIONAL_LID, archived: true }]);
  release({});
  const [message] = await delivered;
  assert.equal(message.chat_archived, true);
});


test("an observed sent event keeps its own account when credentials change during lookup", async (t) => {
  const baileys = await import("@whiskeysockets/baileys");
  let release;
  const { client, ev } = await createHarness({ account: "12025550125@s.whatsapp.net",
    authKeys: { get: async () => ({}) }, baileysOverrides: {
      newLTHashState: baileys.newLTHashState, decodeSyncdSnapshot: baileys.decodeSyncdSnapshot,
      decodePatches: baileys.decodePatches, extractSyncdPatches: async () => ({}) },
    configureSocket: (socket) => { socket.query = () => new Promise((resolve) => { release = resolve; }); } });
  t.after(() => client.disconnect());
  ev.emit("chats.update", [{ id: FICTIONAL_LID, archived: true }]);
  const delivered = once(client, "msg_sent");
  emitContactMessage(ev);
  ev.emit("creds.update", { me: { id: "12025550126@s.whatsapp.net" } });
  await new Promise((resolve) => setImmediate(resolve));
  ev.emit("chats.update", [{ id: FICTIONAL_LID, archived: false }]);
  ev.emit("contacts.upsert", [{ id: FICTIONAL_LID, name: "Replacement account contact" }]);
  release({});
  const [message] = await delivered;
  assert.equal(message.recipient_name, null);
  assert.equal(message.chat_archived, true);
});
