/** Cover pairing validation, socket retirement, notifications, and protected UI routes. */
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PairingActionError, PairingSession, clearUnregisteredPairing,
  normalizePairingPhone, pairingWebUiPath } = require("../pairing");
const { WhatsappClient } = require("../whatsapp");
const { createAddonRuntime } = require("../runtime");
const { createWebUiApp, createStatusSnapshot } = require("../webui");
const { createApiApp } = require("../api");

const PHONE = "12025550123";
const CODE = "ABCD1234";

/** Return a controllable promise for race and notification-order regressions. */
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** Flush queued socket events and notification requests without polling timers. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Exercise a socket-local pairing session using only fictional account data. */
const sessionFixture = (requestPairingCode = async () => CODE) => {
  const updates = [];
  const creds = { registered: false };
  let saved = 0;
  let ended = 0;
  const session = new PairingSession({
    creds,
    socket: { requestPairingCode, end: async () => { ended += 1; } },
    saveCreds: () => { saved += 1; }, onUpdate: (update) => updates.push(update),
  });
  return { session, updates, creds, saved: () => saved, ended: () => ended };
};

/** Check formatting and link validation without accepting identifiers or URLs as phone input. */
test("phone formatting accepts international numbers and rejects ambiguous input", () => {
  for (const number of [PHONE, "+1 (202) 555-0123", "  +1 202 555 0123  "]) assert.equal(normalizePairingPhone(number), PHONE);
  for (const number of [null, 12025550123, "", "+", "02025550123", "123", "1".repeat(16), `${PHONE}@s.whatsapp.net`, "https://example.com", "1e10", "+1/202/5550123"]) {
    assert.throws(() => normalizePairingPhone(number), { code: "invalid_phone_number", status: 400 });
  }
  assert.equal(pairingWebUiPath("0123abcd_whatsapp_addon", "2024.12.0"), "/hassio/ingress/0123abcd_whatsapp_addon");
  assert.equal(pairingWebUiPath("0123abcd_whatsapp_addon", "2026.1.3"), "/hassio/ingress/0123abcd_whatsapp_addon");
  for (const version of ["2026.2.0", "2026.10.4", "2027.1.0"]) {
    assert.equal(pairingWebUiPath("0123abcd_whatsapp_addon", version), "/app/0123abcd_whatsapp_addon");
  }
  for (const slug of [undefined, "//example.com", "one/two", "bad)link", "../outside", ""]) assert.equal(pairingWebUiPath(slug), null);
});

/** Verify a code appears only after handshake readiness and one explicit request. */
test("phone code generation waits for QR readiness and suppresses subsequent QR events", async () => {
  const numbers = [];
  const fixture = sessionFixture(async (number) => { numbers.push(number); return CODE; });
  await assert.rejects(fixture.session.requestCode(PHONE), { code: "pairing_unavailable" });
  assert.equal(fixture.session.onQr(), true);
  assert.equal(await fixture.session.requestCode("+1 (202) 555-0123"), "ABCD-1234");
  assert.deepEqual(numbers, [PHONE]);
  assert.equal(fixture.session.onQr(), false);
  assert.deepEqual(fixture.updates, [
    { method: "phone", pending: true, code: null },
    { method: "phone", pending: false, code: "ABCD-1234" },
  ]);
});

/** Prevent concurrent requests and late responses from reviving a retired pairing code. */
test("closing a pending request prevents stale codes and cleans the provisional identity", async () => {
  const pending = deferred();
  const fixture = sessionFixture(() => pending.promise);
  fixture.session.onQr();
  const request = fixture.session.requestCode(PHONE);
  await assert.rejects(fixture.session.requestCode(PHONE), { code: "pairing_busy" });
  Object.assign(fixture.creds, { me: { id: `${PHONE}@s.whatsapp.net` }, pairingCode: CODE });
  fixture.session.close();
  pending.resolve(CODE);
  await assert.rejects(request, { code: "pairing_changed" });
  assert.equal(fixture.saved(), 1);
  assert.deepEqual(fixture.creds, { registered: false });
  assert.equal(fixture.updates.at(-1).code, null);
  assert.equal(fixture.updates.some((update) => update.code), false);
});

/** Clear secret displays while preserving successfully registered account credentials. */
test("successful linking preserves account credentials and rejects further pairing", async () => {
  const fixture = sessionFixture();
  fixture.session.onQr();
  await fixture.session.requestCode(PHONE);
  Object.assign(fixture.creds, { registered: true, me: { id: `${PHONE}@s.whatsapp.net` }, pairingCode: CODE });
  fixture.session.complete();
  assert.equal(fixture.updates.at(-1).code, null);
  assert.equal(fixture.saved(), 0);
  assert.equal(fixture.creds.me.id, `${PHONE}@s.whatsapp.net`);
  await assert.rejects(fixture.session.requestCode(PHONE), { code: "pairing_unavailable" });
  assert.equal(clearUnregisteredPairing(fixture.creds), false);
});

/** Convert upstream failures into safe errors and retire the affected socket. */
test("upstream errors and malformed codes cannot leak account data", async () => {
  for (const request of [async () => { throw new Error(`private phone ${PHONE} code ${CODE}`); }, async () => "bad code"]) {
    const fixture = sessionFixture(request);
    fixture.session.onQr();
    await assert.rejects(fixture.session.requestCode(PHONE), (error) => {
      assert.equal(error.code, "pairing_failed");
      assert.ok(!error.message.includes(PHONE));
      assert.ok(!error.message.includes(CODE));
      return true;
    });
    assert.equal(fixture.ended(), 1);
    assert.equal(fixture.updates.at(-1).code, null);
  }
});

/** Bound a stalled Baileys send without leaving its old code visible. */
test("a stalled pairing request times out and retires its socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = sessionFixture(() => new Promise(() => {}));
  fixture.session.onQr();
  const request = fixture.session.requestCode(PHONE);
  const rejected = assert.rejects(request, { code: "pairing_failed" });
  t.mock.timers.tick(8_000);
  await rejected;
  assert.equal(fixture.ended(), 1);
});

/** Create a real bridge client around offline Baileys sockets and persisted credentials. */
const clientFixture = async (t, initialCreds = { registered: false }) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-pairing-"));
  const sockets = [];
  const saves = [];
  const creds = { ...initialCreds };
  const baileys = {
    proto: (await import("@whiskeysockets/baileys")).proto,
    DisconnectReason: { loggedOut: 401 },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    useMultiFileAuthState: async () => ({
      state: { creds, keys: {} }, saveCreds: async () => { saves.push(structuredClone(creds)); },
    }),
    default: (options) => {
      const ev = new EventEmitter();
      const socket = { ev, ws: new EventEmitter(), authState: options.auth,
        requestPairingCode: async (number) => {
          Object.assign(creds, { pairingCode: CODE, me: { id: `${number}@s.whatsapp.net`, name: "~" } });
          ev.emit("creds.update", creds);
          return CODE;
        },
        end: async () => ev.emit("connection.update", { connection: "close" }),
      };
      sockets.push(socket);
      return socket;
    },
  };
  const client = new WhatsappClient({ path: directory, baileys, autoConnect: false, offline: false, timeout: 100_000 });
  t.after(async () => { await client.disconnect(); await fs.rm(directory, { recursive: true, force: true }); });
  await client.connect();
  return { client, sockets, creds, saves };
};

/** Verify switching back to QR uses fresh unregistered credentials and ignores old sockets. */
test("the bridge clears abandoned phone credentials before reconnecting for QR", async (t) => {
  const fixture = await clientFixture(t);
  const first = fixture.sockets[0];
  const qrEvents = [];
  fixture.client.on("qr", (qr) => qrEvents.push(qr));
  first.ev.emit("connection.update", { qr: "first-fictional-qr" });
  await fixture.client.requestPairingCode(PHONE);
  first.ev.emit("connection.update", { qr: "suppressed-fictional-qr" });
  await fixture.client.useQrPairing();
  assert.deepEqual(fixture.creds, { registered: false });
  assert.deepEqual(fixture.saves.at(-1), { registered: false });
  first.ev.emit("connection.update", { qr: "stale-fictional-qr", connection: "close" });
  fixture.sockets[1].ev.emit("connection.update", { qr: "fresh-fictional-qr" });
  assert.deepEqual(qrEvents, ["first-fictional-qr", "fresh-fictional-qr"]);
});

/** Recover an interrupted phone attempt at startup without deleting the account directory. */
test("startup removes provisional identities left by an interrupted phone attempt", async (t) => {
  const fixture = await clientFixture(t, { registered: false, pairingCode: CODE, me: { id: `${PHONE}@s.whatsapp.net` } });
  assert.deepEqual(fixture.creds, { registered: false });
  assert.deepEqual(fixture.saves[0], { registered: false });
});

/** Preserve successful phone linking across the restart-required socket replacement. */
test("successful phone pairing survives the subsequent reconnect", async (t) => {
  const fixture = await clientFixture(t);
  const socket = fixture.sockets[0];
  socket.ev.emit("connection.update", { qr: "fictional-qr-code" });
  await fixture.client.requestPairingCode(PHONE);
  fixture.creds.registered = true;
  socket.ev.emit("creds.update", fixture.creds);
  socket.ev.emit("connection.update", { isNewLogin: true });
  socket.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { statusCode: 515 } } });
  await fixture.client.connect();
  assert.equal(fixture.creds.registered, true);
  assert.equal(fixture.creds.me.id, `${PHONE}@s.whatsapp.net`);
  fixture.sockets[1].ev.emit("connection.update", { connection: "open" });
  await assert.rejects(fixture.client.requestPairingCode(PHONE), { code: "pairing_unavailable" });
});

/** Provide isolated account events and Supervisor calls for notification tests. */
const runtimeFixture = (options = {}) => {
  const requests = [];
  const accounts = [];
  const runtime = createAddonRuntime({
    clientIds: ["default", "backup"], logger: {},
    clientFactory: () => {
      const client = new EventEmitter();
      client.requestPairingCode = async () => client.emit("pairing_update", { method: "phone", pending: false, code: "ABCD-1234" });
      client.useQrPairing = async () => client.emit("pairing_update", { method: "qr", pending: false, code: null });
      accounts.push(client);
      return client;
    },
    httpClient: {
      get: async (url) => ({ data: { data: url.endsWith("/core/info") ? { version: "2026.10.4" } : { slug: "0123abcd_whatsapp_addon" } } }),
      post: async (url, body) => { requests.push({ url, body }); },
    }, ...options,
  });
  return { runtime, requests, accounts };
};

/** Retain the initial QR and expose a repository-aware link in the same notification. */
test("initial QR notification links to the protected Home Assistant pairing page", async () => {
  const fixture = runtimeFixture();
  fixture.accounts[0].emit("qr", "fictional-qr-code");
  await flush();
  const notification = fixture.requests.find((request) => request.url.endsWith("/create"));
  assert.match(notification.body.message, /!\[QR code\]\(data:image\/png;base64,/);
  assert.match(notification.body.message, /\[Open pairing page\]\(\/app\/0123abcd_whatsapp_addon\)/);
  assert.equal(notification.body.notification_id, "whatsapp_addon_qrcode_default");
});

/** Keep code selection, throttling, and cleanup independent for configured accounts. */
test("phone pairing is explicit, rate limited, and scoped to its account", async () => {
  const fixture = runtimeFixture();
  await assert.rejects(fixture.runtime.requestPairingCode("default", PHONE), { code: "pairing_unavailable" });
  fixture.accounts.forEach((client) => client.emit("qr", "fictional-qr-code"));
  await assert.rejects(fixture.runtime.requestPairingCode("default", "bad"), { code: "invalid_phone_number" });
  await fixture.runtime.requestPairingCode("default", PHONE);
  assert.equal(fixture.runtime.clientStates.default.pairingCode, "ABCD-1234");
  assert.equal(fixture.runtime.clientStates.default.qrDataUrl, null);
  assert.equal(fixture.runtime.clientStates.backup.pairingCode, null);
  await assert.rejects(fixture.runtime.requestPairingCode("default", PHONE), { status: 429 });
  await fixture.runtime.requestPairingCode("backup", PHONE);
  await assert.rejects(fixture.runtime.requestPairingCode("missing", PHONE), { status: 404 });
  fixture.accounts[0].emit("ready");
  await flush();
  assert.equal(fixture.runtime.clientStates.default.pairingCode, null);
  const notifications = fixture.requests.filter((request) => request.body.notification_id === "whatsapp_addon_qrcode_default");
  assert.ok(notifications.at(-1).url.endsWith("/dismiss"));
});

/** Serialize updates through a slow Supervisor lookup so linking cannot resurrect a QR. */
test("a delayed link lookup cannot recreate a notification after successful pairing", async () => {
  const info = deferred();
  const requests = [];
  const fixture = runtimeFixture({ httpClient: {
    get: () => info.promise, post: async (url, body) => { requests.push({ url, body }); },
  } });
  fixture.accounts[0].emit("qr", "fictional-qr-code");
  await flush();
  fixture.accounts[0].emit("ready");
  info.resolve({ data: { data: { slug: "0123abcd_whatsapp_addon" } } });
  await flush();
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.url.endsWith("/dismiss")));
});

/** Bound slow notification delivery to the in-flight request and the latest state. */
test("a burst of QR updates is coalesced while Supervisor delivery is slow", async () => {
  const blocked = deferred();
  const requests = [];
  const fixture = runtimeFixture({ httpClient: {
    get: async (url) => ({ data: { data: url.endsWith("/core/info") ? { version: "2026.10.4" } : { slug: "0123abcd_whatsapp_addon" } } }),
    post: async (url, body) => { requests.push({ url, body }); if (requests.length === 1) await blocked.promise; },
  } });
  fixture.accounts[0].emit("qr", "fictional-first-qr");
  await flush();
  for (let index = 0; index < 25; index += 1) fixture.accounts[0].emit("qr", `fictional-qr-${index}`);
  fixture.accounts[0].emit("ready");
  blocked.resolve();
  await fixture.runtime.flushPairingNotifications();
  assert.equal(requests.length, 2);
  assert.ok(requests.at(-1).url.endsWith("/dismiss"));
});

/** Remove codes and their notification when account recovery pauses the bridge. */
test("recovery clears displayed phone codes and blocks pairing actions", async () => {
  const fixture = runtimeFixture({ persistRecoveryRecordSyncFn: () => {} });
  fixture.accounts[0].emit("qr", "fictional-qr-code");
  await fixture.runtime.requestPairingCode("default", PHONE);
  await fixture.runtime.enterRecovery({ failedDecryptMessages: 10 });
  await fixture.runtime.flushPairingNotifications();
  assert.equal(fixture.runtime.clientStates.default.pairingCode, null);
  await assert.rejects(fixture.runtime.requestPairingCode("default", PHONE), { code: "pairing_unavailable" });
  const notifications = fixture.requests.filter((request) => request.body.notification_id === "whatsapp_addon_qrcode_default");
  assert.ok(notifications.at(-1).url.endsWith("/dismiss"));
});

/** Start an HTTP server that closes automatically after each protected-route test. */
const serve = async (t, app) => {
  const server = await new Promise((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

/** Require authenticated ingress, JSON, and an explicit header before accepting pairing writes. */
test("pairing routes protect writes and return only sanitized failures", async (t) => {
  const actions = [];
  const app = createWebUiApp({ clients: {}, clientStates: {}, allowedIngressAddress: "127.0.0.1",
    requestPairingCode: async (...args) => { actions.push(args); },
    useQrPairing: async () => { throw new PairingActionError(409, "pairing_busy", "A pairing request is already in progress."); },
  });
  const url = await serve(t, app);
  const headers = { "content-type": "application/json", "x-whatsapp-pairing": "1" };
  let response = await fetch(`${url}/api/pairing/phone`, { method: "POST", headers, body: JSON.stringify({ clientId: "default", phoneNumber: PHONE }) });
  assert.equal(response.status, 200);
  assert.deepEqual(actions, [["default", PHONE]]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const badHeaders of [{ "content-type": "application/json" }, { ...headers, "sec-fetch-site": "cross-site" }]) {
    response = await fetch(`${url}/api/pairing/phone`, { method: "POST", headers: badHeaders, body: "{}" });
    assert.equal(response.status, 403);
  }
  response = await fetch(`${url}/api/pairing/phone`, { method: "POST", headers, body: JSON.stringify({ clientId: "default", unknown: "private" }) });
  assert.equal(response.status, 400);
  response = await fetch(`${url}/api/pairing/qr`, { method: "POST", headers, body: JSON.stringify({ clientId: "default" }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "pairing_busy");
  const guarded = await serve(t, createWebUiApp({ clients: {}, clientStates: {} }));
  response = await fetch(`${guarded}/api/pairing/phone`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 403);
});

/** Keep codes in ingress while the integration status API continues to expose state only. */
test("pairing codes never enter the integration status API", async (t) => {
  const clients = { default: {} };
  const clientStates = { default: { state: "pairing", pairingCode: "ABCD-1234", pairingMethod: "phone", pairingPending: false } };
  assert.equal(createStatusSnapshot({ clients, clientStates }).clients[0].pairingCode, "ABCD-1234");
  const url = await serve(t, createApiApp({ clients, clientStates, sharedSecret: "fictional-private-token", logger: {} }));
  const response = await fetch(`${url}/status`, { headers: { Authorization: "Bearer fictional-private-token" } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes("ABCD-1234"));
  assert.ok(!body.includes("pairingCode"));
});
