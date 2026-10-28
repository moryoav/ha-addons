/** Verify custom device registration and canonical phone-code IQs in installed Baileys. */
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const test = require("node:test");
const { PairingSession } = require("../pairing");

/** Wait for the local transport or decoded stanza, with a bounded deadline. */
const waitFor = async (condition) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("The loopback pairing transport did not reach the expected state.");
};

/** Exercise the real serializer over loopback without connecting to WhatsApp. */
test("custom device labels preserve canonical phone-code requests in real Baileys", async (t) => {
  const baileys = await import("@whiskeysockets/baileys");
  const fromBaileys = createRequire(require.resolve("@whiskeysockets/baileys"));
  const { WebSocketServer } = fromBaileys("ws");
  const logger = { level: "silent", child() { return this; } };
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) logger[level] = () => {};
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let socket;
  t.after(async () => {
    socket?.end(undefined);
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const wire = [];
  server.on("connection", (connection) => connection.on("message", async (data) => {
    let bytes = Buffer.from(data);
    if (bytes[0] === 0x57 && bytes[1] === 0x41) bytes = bytes.subarray(4);
    while (bytes.length >= 3) {
      const size = (bytes[0] << 16) | bytes.readUInt16BE(1);
      const frame = bytes.subarray(3, 3 + size);
      bytes = bytes.subarray(3 + size);
      try {
        const node = await baileys.decodeBinaryNode(frame);
        if (node?.tag === "iq") wire.push(node);
      } catch {
        // The silent server leaves noise negotiation unfinished. Its initial
        // ClientHello is protobuf, while subsequent test stanzas are plaintext.
      }
    }
  }));

  const browser = ["Home Assistant", "Chrome", "20.0.04"];
  const creds = baileys.initAuthCreds();
  const config = { ...baileys.DEFAULT_CONNECTION_CONFIG, browser, version: [2, 3000, 1],
    syncFullHistory: false, auth: { creds, keys: { get: async () => ({}), set: async () => {} } },
    logger, waWebSocketUrl: `ws://127.0.0.1:${server.address().port}`, connectTimeoutMs: 0 };
  const registration = baileys.generateRegistrationNode(creds, config);
  assert.equal(baileys.proto.DeviceProps.decode(registration.devicePairingData.deviceProps).os, "Home Assistant");
  socket = baileys.default(config);
  await waitFor(() => socket.ws.isOpen);
  const session = new PairingSession({ socket, browser, creds, saveCreds: () => {}, onUpdate: () => {} });
  session.onQr();
  const code = await session.requestCode("12025550123");
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await waitFor(() => wire.some((node) => node.content?.some((child) => child.tag === "link_code_companion_reg")));
  const request = wire.flatMap((node) => node.content).find((node) => node.tag === "link_code_companion_reg");
  assert.equal(request.attrs.stage, "companion_hello");
  assert.equal(request.content.find((node) => node.tag === "companion_platform_id").content.toString(), "1");
  assert.equal(request.content.find((node) => node.tag === "companion_platform_display").content.toString(), "Chrome (Ubuntu)");
  assert.deepEqual(browser, ["Home Assistant", "Chrome", "20.0.04"]);
  const after = baileys.generateRegistrationNode(creds, config);
  assert.equal(baileys.proto.DeviceProps.decode(after.devicePairingData.deviceProps).os, "Home Assistant");
});
