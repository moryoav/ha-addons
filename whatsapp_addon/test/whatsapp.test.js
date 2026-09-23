const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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
} = {}) => {
  const ev = new EventEmitter();
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
    downloadMediaMessage,
    DisconnectReason: { loggedOut: 401 },
    default: (options) => {
      calls.socketOptions.push(options);
      return socket;
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    useMultiFileAuthState: async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: async () => {},
    }),
  };
  const client = new WhatsappClient({
    path: "session-test",
    baileys,
    autoConnect: false,
    offline: false,
    decryptionDiagnostics,
  });
  await client.connect();
  ev.emit("connection.update", { connection: "open" });

  return { baileys, calls, client, ev, socket, ws };
};

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
  ev.emit("messages.upsert", { type: "notify", messages: [incoming, incoming, {
    key: { id: "fictional-text", remoteJid: FICTIONAL_JID, fromMe: false },
    message: { conversation: "Fictional text" },
  }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(enriched.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].type, "conversation");
  const media = { status: "ready", local_path: "/media/whatsapp/fictional/file.jpg", url: "/api/whatsapp/media/fictional" };
  ready(media);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1][1], { clientId: "default", type: "imageMessage", ...incoming, media });
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
