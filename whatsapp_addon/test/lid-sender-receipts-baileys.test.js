const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const test = require("node:test");
const { attachLidSenderReceipts } = require("../lid-sender-receipts");

// Drives the installed Baileys receive path with real Signal sessions. The only
// transport is a silent loopback WebSocket server: no WhatsApp host is contacted
// and every identity, key and message below is generated or fictional.
const OWN_LID = "999999999999991";
const PEER = "999999999999992@lid";
const DESKTOP = `${OWN_LID}:22@lid`;
const silent = { level: "silent", child() { return this; } };
for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) silent[level] = () => {};

const waitFor = async (check, label) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}`);
};

const start = async (t) => {
  const baileys = await import("@whiskeysockets/baileys");
  const { default: makeWASocket, initAuthCreds, Curve, generateSignalPubKey,
    encodeWAMessage, decodeBinaryNode } = baileys;
  // Resolve Baileys' own transport and Signal libraries exactly as Baileys does.
  const fromBaileys = createRequire(require.resolve("@whiskeysockets/baileys"));
  const { WebSocketServer } = fromBaileys("ws");
  const libsignal = fromBaileys("libsignal");

  // Frames stay unencrypted until the noise handshake completes, which a silent
  // server never allows, so each stanza the client writes can be decoded here.
  const wire = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (connection) => connection.on("message", async (data) => {
    let bytes = Buffer.from(data);
    if (bytes[0] === 0x57 && bytes[1] === 0x41) bytes = bytes.subarray(4); // "WA" intro
    while (bytes.length >= 3) {
      const size = (bytes[0] << 16) | bytes.readUInt16BE(1);
      const frame = bytes.subarray(3, 3 + size);
      bytes = bytes.subarray(3 + size);
      try {
        const node = await decodeBinaryNode(frame);
        if (["receipt", "ack"].includes(node?.tag)) wire.push(node.attrs);
      } catch {
        // The noise ClientHello is a protobuf, not a stanza.
      }
    }
  }));

  const creds = initAuthCreds();
  creds.me = { id: "12025550123:9@s.whatsapp.net", lid: `${OWN_LID}:9@lid`, name: "Fictional" };
  const stored = {};
  const keys = {
    get: async (type, ids) => Object.fromEntries(
      ids.filter((id) => stored[type]?.[id] != null).map((id) => [id, stored[type][id]])),
    set: async (data) => {
      for (const [type, entries] of Object.entries(data)) {
        stored[type] ||= {};
        for (const [id, value] of Object.entries(entries)) {
          if (value == null) delete stored[type][id];
          else stored[type][id] = value;
        }
      }
    },
  };
  const preKey = Curve.generateKeyPair();
  await keys.set({ "pre-key": { 7: preKey } });

  const socket = makeWASocket({
    auth: { creds, keys }, logger: silent, version: [2, 3000, 1], syncFullHistory: false,
    waWebSocketUrl: `ws://127.0.0.1:${server.address().port}`,
    // The handshake never completes here; its default 20-second timer would
    // otherwise end the socket mid-test or outlive end() and delay the exit.
    connectTimeoutMs: 0,
  });
  t.after(async () => {
    socket.end(undefined);
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitFor(() => socket.ws.isOpen, "the loopback transport");

  // The account's own desktop companion: a plain libsignal peer of the add-on.
  const identity = Curve.generateKeyPair();
  const sessions = new Map();
  const desktop = {
    loadSession: async (id) => sessions.has(id)
      ? libsignal.SessionRecord.deserialize(JSON.parse(sessions.get(id))) : undefined,
    storeSession: async (id, record) => { sessions.set(id, JSON.stringify(record.serialize())); },
    isTrustedIdentity: () => true,
    getOurRegistrationId: () => 4321,
    getOurIdentity: () => ({ privKey: Buffer.from(identity.private),
      pubKey: Buffer.from(generateSignalPubKey(identity.public)) }),
  };
  const addon = new libsignal.ProtocolAddress(OWN_LID, 9);
  await new libsignal.SessionBuilder(desktop, addon).initOutgoing({
    identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
    registrationId: creds.registrationId,
    preKey: { keyId: 7, publicKey: generateSignalPubKey(preKey.public) },
    signedPreKey: { keyId: creds.signedPreKey.keyId, signature: creds.signedPreKey.signature,
      publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public) },
  });
  const cipher = new libsignal.SessionCipher(desktop, addon);
  const ownMessage = async (id, content) => {
    const padded = encodeWAMessage({ deviceSentMessage: { destinationJid: PEER, message: content } });
    const { type, body } = await cipher.encrypt(Buffer.from(padded));
    return { tag: "message", attrs: { from: DESKTOP, recipient: PEER, id, t: "1788603786", type: "text" },
      content: [{ tag: "enc", attrs: { v: "2", type: type === 3 ? "pkmsg" : "msg" },
        content: Buffer.from(body, "binary") }] };
  };
  const deliver = async (node, expected, offline = false) => {
    const from = wire.length;
    socket.ws.emit("CB:message", offline ? { ...node, attrs: { ...node.attrs, offline: "1" } } : node);
    await waitFor(() => wire.length >= from + expected, `${expected} stanza(s) for ${node.attrs.id}`);
    await new Promise((resolve) => setTimeout(resolve, 50)); // Surface any stray extra write.
    return wire.slice(from);
  };
  return { socket, ownMessage, deliver };
};

const misrouted = (id) => ({ id, to: PEER, type: "sender" });
const corrected = (id) => ({ id, type: "sender", to: DESKTOP, recipient: PEER });

test("installed Baileys misroutes own-device direct-LID sender receipts", async (t) => {
  const h = await start(t);
  assert.deepEqual(await h.deliver(await h.ownMessage("fictional-premise", { conversation: "Fictional" }), 1),
    [misrouted("fictional-premise")],
    "Baileys no longer misroutes this receipt: the experimental workaround may be obsolete.");
});

test("real decryptions of text, control messages and retry copies each get the corrected receipt", async (t) => {
  const h = await start(t);
  const helper = attachLidSenderReceipts({ socket: h.socket });
  t.after(() => helper.close());

  const text = await h.ownMessage("fictional-text", { conversation: "Fictional message" });
  assert.deepEqual(await h.deliver(text, 2), [misrouted("fictional-text"), corrected("fictional-text")]);

  const deletion = await h.ownMessage("fictional-delete", { protocolMessage: {
    type: 0, key: { remoteJid: PEER, fromMe: true, id: "fictional-text" } } });
  assert.deepEqual(await h.deliver(deletion, 2),
    [misrouted("fictional-delete"), corrected("fictional-delete")]);

  // Redelivery of an already-decrypted stanza: Baileys rejects it, and so must we.
  const [nack] = await h.deliver(text, 1, true);
  assert.equal(nack.class, "message");
  assert.equal(nack.error, "487");

  // The origin device's fresh copy of that ID decrypts, so it is acknowledged.
  const retry = await h.ownMessage("fictional-text", { conversation: "Fictional message" });
  assert.deepEqual(await h.deliver(retry, 2), [misrouted("fictional-text"), corrected("fictional-text")]);
});
