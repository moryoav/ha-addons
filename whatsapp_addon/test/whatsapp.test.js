const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  WhatsappClient,
  WhatsappDisconnectedError,
  WhatsappProtocolError,
  WhatsappUpstreamError,
  normalizeRecipientJid,
} = require("../whatsapp");
const { RequestValidationError } = require("../validation");

const FICTIONAL_NUMBER = "12025550123";
const FICTIONAL_JID = `${FICTIONAL_NUMBER}@s.whatsapp.net`;
const FICTIONAL_LID = "999999999999999@lid";

const createHarness = async ({ onWhatsApp } = {}) => {
  const ev = new EventEmitter();
  const calls = {
    end: 0,
    onWhatsApp: [],
    presenceSubscribe: [],
    sendMessage: [],
    sendPresenceUpdate: [],
  };
  const socket = {
    ev,
    async end() {
      calls.end += 1;
    },
    async onWhatsApp(jid) {
      calls.onWhatsApp.push(jid);
      return onWhatsApp ? onWhatsApp(jid) : [];
    },
    async presenceSubscribe(jid) {
      calls.presenceSubscribe.push(jid);
    },
    async readMessages() {},
    async sendMessage(jid, message, options) {
      calls.sendMessage.push({ jid, message, options });
      return { key: { id: "fictional-message-id" } };
    },
    async sendPresenceUpdate(type, jid) {
      calls.sendPresenceUpdate.push({ type, jid });
    },
    async updateProfileStatus() {},
  };
  const baileys = {
    DisconnectReason: { loggedOut: 401 },
    default: () => socket,
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
  });
  await client.connect();
  ev.emit("connection.update", { connection: "open" });

  return { baileys, calls, client, ev, socket };
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

test("general recipient normalization retains supported direct JIDs", () => {
  assert.equal(normalizeRecipientJid(FICTIONAL_JID), FICTIONAL_JID);
  assert.equal(
    normalizeRecipientJid("120363000000000000@g.us"),
    "120363000000000000@g.us"
  );
  assert.equal(normalizeRecipientJid(FICTIONAL_LID), FICTIONAL_LID);
});
