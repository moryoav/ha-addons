/** Round-trip real auth files across fresh clients using only fictional link identities. */
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WhatsappClient } = require("../whatsapp");

const PHONE = "12025550123";
const CODE = "ABCD1234";

/** Reload credentials through the pinned serializer instead of reusing a mock auth object. */
test("fresh clients recover interrupted phone linking and retain signed identities on disk", async (t) => {
  const actual = await import("@whiskeysockets/baileys");
  const signed = { details: Buffer.from("fictional-signed-account") };
  const device = { id: `${PHONE}:7@s.whatsapp.net` };
  const cases = [
    { name: "phone confirmation before pair-success", initial: {
      registered: true, pairingCode: CODE, me: { id: `${PHONE}@s.whatsapp.net` },
    }, registered: false },
    { name: "QR pair-success after a phone request", initial: {
      registered: false, pairingCode: CODE, account: signed, me: device,
    }, registered: false, me: device, account: signed },
    { name: "completed phone pair-success", initial: {
      registered: true, pairingCode: CODE, account: signed, me: device,
    }, registered: true, me: device, account: signed },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-auth-roundtrip-"));
      const clients = [], loaded = [];
      t.after(async () => {
        for (const client of clients) await client.disconnect();
        await fs.rm(directory, { recursive: true, force: true });
      });
      const seed = await actual.useMultiFileAuthState(directory);
      Object.assign(seed.state.creds, scenario.initial);
      await seed.saveCreds();
      const baileys = {
        proto: actual.proto,
        fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
        useMultiFileAuthState: actual.useMultiFileAuthState,
        default: ({ auth }) => {
          loaded.push(auth.creds);
          const ev = new EventEmitter();
          return { ev, ws: new EventEmitter(), end: () => {
            ev.emit("connection.update", { connection: "close" });
            ev.removeAllListeners("connection.update");
          } };
        },
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const client = new WhatsappClient({ path: directory, baileys, autoConnect: false });
        clients.push(client);
        await client.connect();
        const creds = loaded.at(-1);
        assert.equal(creds.registered, scenario.registered);
        assert.equal(creds.pairingCode, undefined);
        assert.deepEqual(creds.me, scenario.me);
        assert.deepEqual(creds.account, scenario.account);
        await client.disconnect();
      }
      assert.notEqual(loaded[0], loaded[1]);
      const reopened = await actual.useMultiFileAuthState(directory);
      assert.equal(reopened.state.creds.pairingCode, undefined);
      assert.equal(reopened.state.creds.registered, scenario.registered);
      assert.deepEqual(reopened.state.creds.me, scenario.me);
      assert.deepEqual(reopened.state.creds.account, scenario.account);
    });
  }
});

/** Keep work a replaced socket finishes late, since the newer socket loaded its own credentials. */
test("late partial updates from a replaced socket reach the current credentials on disk", async (t) => {
  const actual = await import("@whiskeysockets/baileys");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-auth-late-"));
  const sockets = [];
  const seed = await actual.useMultiFileAuthState(directory);
  Object.assign(seed.state.creds, { registered: true, me: { id: `${PHONE}:7@s.whatsapp.net` },
    account: { details: Buffer.from("fictional-signed-account") }, nextPreKeyId: 31, firstUnuploadedPreKeyId: 31 });
  await seed.saveCreds();
  const baileys = {
    proto: actual.proto,
    DisconnectReason: actual.DisconnectReason,
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    useMultiFileAuthState: actual.useMultiFileAuthState,
    default: ({ auth }) => {
      const ev = new EventEmitter();
      // Like Baileys, each socket applies updates to the credentials it was created with.
      ev.on("creds.update", (update) => Object.assign(auth.creds, update));
      const socket = { ev, ws: new EventEmitter(), authState: auth, end: () => ev.emit("connection.update", { connection: "close" }) };
      sockets.push(socket);
      return socket;
    },
  };
  const client = new WhatsappClient({ path: directory, baileys, autoConnect: false, timeout: 1 });
  t.after(async () => { await client.disconnect(); await fs.rm(directory, { recursive: true, force: true }); });
  await client.connect();
  const [replaced] = sockets;
  replaced.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { statusCode: 428 } } });
  const deadline = Date.now() + 2_000;
  while (sockets.length < 2) {
    assert.ok(Date.now() < deadline, "The client did not reconnect.");
    await new Promise((resolve) => setImmediate(resolve));
  }
  const current = sockets[1];
  current.ev.emit("creds.update", { nextPreKeyId: 61, firstUnuploadedPreKeyId: 61 });
  replaced.ev.emit("creds.update", { myAppStateKeyId: "AAAAAQ==", nextPreKeyId: 41, firstUnuploadedPreKeyId: 41 });
  // The replaced socket's whole object is stale, so it must not overwrite newer values.
  replaced.authState.creds.lastPropHash = "fictional-stale-hash";
  replaced.ev.emit("creds.update", replaced.authState.creds);
  await client.disconnect();
  const reopened = await actual.useMultiFileAuthState(directory);
  for (const creds of [current.authState.creds, reopened.state.creds]) {
    assert.equal(creds.myAppStateKeyId, "AAAAAQ==");
    assert.equal(creds.nextPreKeyId, 61);
    assert.equal(creds.firstUnuploadedPreKeyId, 61);
    assert.equal(creds.lastPropHash, undefined);
    assert.equal(creds.me.id, `${PHONE}:7@s.whatsapp.net`);
  }
});
