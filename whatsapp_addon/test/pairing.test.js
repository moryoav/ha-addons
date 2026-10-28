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
const { QUERY_TIMEOUT_MS } = require("../timeout");

const PHONE = "12025550123";
const CODE = "ABCD1234";

/** Return a controllable promise for race and notification-order regressions. */
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
  const account = { details: "fictional-signed-account" };
  Object.assign(fixture.creds, { registered: true, account, me: { id: `${PHONE}:7@s.whatsapp.net` }, pairingCode: CODE });
  fixture.session.complete();
  assert.equal(fixture.updates.at(-1).code, null);
  assert.equal(fixture.saved(), 0);
  assert.equal(fixture.creds.me.id, `${PHONE}:7@s.whatsapp.net`);
  await assert.rejects(fixture.session.requestCode(PHONE), { code: "pairing_unavailable" });
  assert.equal(clearUnregisteredPairing(fixture.creds), true);
  assert.equal(fixture.creds.pairingCode, undefined);
  assert.deepEqual(fixture.creds.account, account);
  assert.equal(fixture.creds.registered, true);
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
const clientFixture = async (t, initialCreds = { registered: false }, { timeout = 100_000, authGate, saveGate, connect = true } = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-pairing-"));
  const sockets = [];
  const saves = [];
  const creds = { ...initialCreds };
  let authCalls = 0;
  const baileys = {
    proto: (await import("@whiskeysockets/baileys")).proto,
    DisconnectReason: { loggedOut: 401 },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    useMultiFileAuthState: async () => {
      // Each connect attempt loads credentials once, so tests can pause or fail a chosen attempt.
      authCalls += 1;
      await authGate?.(authCalls);
      return { state: { creds, keys: {} }, saveCreds: async () => {
        const snapshot = structuredClone(creds);
        if (saveGate) await saveGate(snapshot);
        saves.push(snapshot);
      } };
    },
    default: (options) => {
      const ev = new EventEmitter();
      const socket = { ev, ws: new EventEmitter(), authState: options.auth, requests: [], ended: false,
        requestPairingCode: async (number) => {
          socket.requests.push(number);
          Object.assign(creds, { pairingCode: CODE, me: { id: `${number}@s.whatsapp.net`, name: "~" } });
          ev.emit("creds.update", creds);
          return CODE;
        },
        end: async () => {
          socket.ended = true;
          ev.emit("connection.update", { connection: "close" });
        },
      };
      sockets.push(socket);
      return socket;
    },
  };
  const client = new WhatsappClient({ path: directory, baileys, autoConnect: false, offline: false, timeout });
  t.after(async () => { await client.disconnect(); await fs.rm(directory, { recursive: true, force: true }); });
  if (connect) await client.connect();
  return { client, baileys, sockets, creds, saves, authCalls: () => authCalls };
};

/** Wait for asynchronous bridge work without fixed delays, even while timers are mocked. */
const waitFor = async (condition) => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "The bridge did not reach the expected state.");
    await flush();
  }
};

/** Request a code, then complete the fresh handshake the bridge opens for it. */
const requestFreshCode = async (fixture) => {
  const count = fixture.sockets.length;
  const code = fixture.client.requestPairingCode(PHONE);
  await waitFor(() => fixture.sockets.length > count);
  fixture.sockets.at(-1).ev.emit("connection.update", { qr: "handshake-fictional-qr" });
  return code;
};

/** Give each code a fresh socket, so the previous socket's QR timer cannot expire it. */
test("phone codes are requested on a fresh socket whose QR stays hidden", async (t) => {
  const fixture = await clientFixture(t);
  const qrEvents = [];
  fixture.client.on("qr", (qr) => qrEvents.push(qr));
  fixture.sockets[0].ev.emit("connection.update", { qr: "first-fictional-qr" });
  assert.equal(await requestFreshCode(fixture), "ABCD-1234");
  assert.equal(fixture.sockets[0].ended, true);
  assert.deepEqual(fixture.sockets.map((socket) => socket.requests), [[], [PHONE]]);
  fixture.sockets[1].ev.emit("connection.update", { qr: "rotated-fictional-qr" });
  assert.deepEqual(qrEvents, ["first-fictional-qr"]);
});

/** Show the fresh socket's QR again when its handshake misses the request deadline. */
test("a phone request fails cleanly when its fresh socket never becomes ready", async (t) => {
  const fixture = await clientFixture(t);
  fixture.sockets[0].ev.emit("connection.update", { qr: "first-fictional-qr" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(fixture.client.requestPairingCode(PHONE), { code: "pairing_failed", status: 502 });
  await waitFor(() => fixture.sockets.length === 2);
  t.mock.timers.tick(15_000);
  await rejected;
  const qrEvents = [];
  fixture.client.on("qr", (qr) => qrEvents.push(qr));
  fixture.sockets[1].ev.emit("connection.update", { qr: "late-fictional-qr" });
  assert.deepEqual(qrEvents, ["late-fictional-qr"]);
  assert.deepEqual(fixture.sockets[1].requests, []);
});

/** Answer a waiting phone request as soon as no fresh socket can arrive, not at its deadline. */
test("a stop or logout before the fresh QR ends a phone request at once", async (t) => {
  for (const interrupt of [
    (fixture) => fixture.client.disconnect(),
    (fixture) => fixture.sockets[1].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { statusCode: 401 } } }),
  ]) {
    const fixture = await clientFixture(t);
    fixture.sockets[0].ev.emit("connection.update", { qr: "first-fictional-qr" });
    let outcome;
    fixture.client.requestPairingCode(PHONE).then((code) => { outcome = code; }, (error) => { outcome = error; });
    await waitFor(() => fixture.sockets.length === 2);
    await interrupt(fixture);
    await waitFor(() => outcome !== undefined);
    assert.equal(outcome.code, "pairing_changed");
    assert.equal(outcome.status, 409);
    assert.deepEqual(fixture.sockets[1].requests, []);
  }
  // A stop while the fresh socket still loads credentials rejects a handshake nothing awaits yet.
  const gate = deferred();
  const fixture = await clientFixture(t, undefined, { authGate: (call) => (call === 2 ? gate.promise : undefined) });
  fixture.sockets[0].ev.emit("connection.update", { qr: "first-fictional-qr" });
  const request = fixture.client.requestPairingCode(PHONE);
  await waitFor(() => fixture.authCalls() === 2);
  await fixture.client.disconnect();
  gate.resolve();
  await assert.rejects(request, { code: "pairing_changed", status: 409 });
  assert.equal(fixture.sockets.length, 1);
});

/** Fall back to Baileys' bundled version before a fresh phone handshake times out. */
test("a stalled version lookup cannot strand a fresh phone pairing connection", async (t) => {
  const fixture = await clientFixture(t);
  const axios = (await import("axios")).default;
  const { fetchLatestBaileysVersion } = await import("@whiskeysockets/baileys");
  const requests = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(axios, "get", (url, options) => {
    requests.push({ url, options });
    return new Promise((resolve, reject) => {
      if (options.timeout > 0) setTimeout(() => reject(new Error("Synthetic metadata timeout")), options.timeout);
    });
  });
  fixture.baileys.fetchLatestBaileysVersion = fetchLatestBaileysVersion;
  fixture.sockets[0].ev.emit("connection.update", { qr: "first-fictional-qr" });
  const request = fixture.client.requestPairingCode(PHONE);
  const settled = request.then((code) => ({ code }), (error) => ({ error }));
  try {
    await waitFor(() => requests.length === 1);
    assert.equal(requests[0].options.timeout, QUERY_TIMEOUT_MS);
    assert.ok(QUERY_TIMEOUT_MS < 15_000);
    t.mock.timers.tick(QUERY_TIMEOUT_MS);
    await waitFor(() => fixture.sockets.length === 2);
    fixture.sockets[1].ev.emit("connection.update", { qr: "fallback-version-fictional-qr" });
    assert.equal((await settled).code, "ABCD-1234");
    assert.equal(fixture.sockets[1].ended, false);
  } finally {
    t.mock.timers.tick(15_000);
    await settled;
  }
});

/** Verify switching back to QR uses fresh unregistered credentials and ignores old sockets. */
test("the bridge clears abandoned phone credentials before reconnecting for QR", async (t) => {
  const fixture = await clientFixture(t);
  const first = fixture.sockets[0];
  const qrEvents = [];
  fixture.client.on("qr", (qr) => qrEvents.push(qr));
  first.ev.emit("connection.update", { qr: "first-fictional-qr" });
  await requestFreshCode(fixture);
  const phoneSocket = fixture.sockets[1];
  phoneSocket.ev.emit("connection.update", { qr: "suppressed-fictional-qr" });
  await fixture.client.useQrPairing();
  assert.deepEqual(fixture.creds, { registered: false });
  assert.deepEqual(fixture.saves.at(-1), { registered: false });
  for (const stale of [first, phoneSocket]) {
    stale.ev.emit("connection.update", { qr: "stale-fictional-qr", connection: "close" });
  }
  fixture.sockets[2].ev.emit("connection.update", { qr: "fresh-fictional-qr" });
  assert.deepEqual(qrEvents, ["first-fictional-qr", "fresh-fictional-qr"]);
});

/** Keep retrying after a failed pairing reconnect, as the other connection paths do. */
test("switching pairing methods retries when the reconnect fails", async (t) => {
  const fixture = await clientFixture(t, undefined, { timeout: 20, authGate: (call) => {
    if (call === 2) throw new Error("Fictional storage failure.");
  } });
  fixture.sockets[0].ev.emit("connection.update", { qr: "first-fictional-qr" });
  await assert.rejects(fixture.client.useQrPairing(), /Fictional storage failure/);
  await waitFor(() => fixture.sockets.length === 2);
});

/** Let a stop that lands during a pairing restart, such as a recovery pause, win. */
test("a stop during a pairing restart leaves the client without a socket", async (t) => {
  const gate = deferred();
  const fixture = await clientFixture(t, undefined, { authGate: (call) => (call === 2 ? gate.promise : undefined) });
  fixture.sockets[0].ev.emit("connection.update", { qr: "first-fictional-qr" });
  const switching = fixture.client.useQrPairing();
  await waitFor(() => fixture.authCalls() === 2);
  await fixture.client.disconnect();
  gate.resolve();
  await assert.rejects(switching, { code: "pairing_changed", status: 409 });
  assert.equal(fixture.sockets.length, 1);
});

/** Do not reopen session storage when a stopped connection finishes its version lookup. */
test("a stopped connect skips a late credential load", async (t) => {
  const gate = deferred();
  const fixture = await clientFixture(t, undefined, { connect: false });
  let lookupStarted = false;
  fixture.baileys.fetchLatestBaileysVersion = () => { lookupStarted = true; return gate.promise; };
  const connecting = fixture.client.connect();
  await waitFor(() => lookupStarted);
  await fixture.client.disconnect();
  gate.resolve({ version: [2, 3000, 1] });
  await connecting;
  assert.equal(fixture.authCalls(), 0);
  assert.equal(fixture.sockets.length, 0);
});

/** Leave replacement credentials untouched when an earlier auth load finishes after stop. */
test("a stopped connect cannot save provisional credentials from a late auth load", async (t) => {
  const gate = deferred();
  const provisional = { registered: false, pairingCode: CODE, me: { id: `${PHONE}@s.whatsapp.net` } };
  const fixture = await clientFixture(t, provisional, { connect: false, authGate: () => gate.promise });
  const connecting = fixture.client.connect();
  await waitFor(() => fixture.authCalls() === 1);
  await fixture.client.disconnect();
  const replacement = { registered: true, account: { details: "fictional-replacement-account" } };
  fixture.saves.push(replacement);
  gate.resolve();
  await connecting;
  assert.deepEqual(fixture.saves, [replacement]);
  assert.equal(fixture.sockets.length, 0);
});

/** Wait for an already-started startup cleanup write before handing storage to a reset. */
test("disconnect waits for startup credential cleanup before completing", async (t) => {
  const gate = deferred();
  let saveStarted = false;
  const provisional = { registered: false, pairingCode: CODE, me: { id: `${PHONE}@s.whatsapp.net` } };
  const fixture = await clientFixture(t, provisional, { connect: false, saveGate: () => {
    saveStarted = true;
    return gate.promise;
  } });
  const connecting = fixture.client.connect();
  await waitFor(() => saveStarted);
  let stopped = false;
  const stopping = fixture.client.disconnect().then(() => { stopped = true; });
  await flush();
  const stoppedBeforeSave = stopped;
  gate.resolve();
  await Promise.all([connecting, stopping]);
  assert.equal(stoppedBeforeSave, false);
  assert.equal(stopped, true);
  assert.equal(fixture.sockets.length, 0);
});

/** Ignore credential events from Baileys work that was still awaiting keys when stopped. */
test("late Baileys key-share processing cannot save credentials after disconnect", async (t) => {
  const fixture = await clientFixture(t, { registered: true, me: { id: `${PHONE}:7@s.whatsapp.net` } });
  const { default: processMessage } = await import("@whiskeysockets/baileys/lib/Utils/process-message.js");
  const socket = fixture.sockets[0];
  const gate = deferred();
  let blockKeys = false, keyWriteStarted = false;
  const context = {
    creds: fixture.creds,
    ev: socket.ev,
    keyStore: {
      transaction: async (work) => work(),
      set: async () => {
        if (blockKeys) { keyWriteStarted = true; await gate.promise; }
      },
    },
    options: {},
  };
  const message = {
    key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true, id: "fictional-key-share" },
    messageTimestamp: 1,
    message: { protocolMessage: {
      type: fixture.baileys.proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
      appStateSyncKeyShare: { keys: [{
        keyId: { keyId: Buffer.from("fictional-key-id") }, keyData: { keyData: Buffer.alloc(32, 1) },
      }] },
    } },
  };
  await processMessage(message, context);
  await flush();
  assert.equal(fixture.saves.length, 1);
  blockKeys = true;
  const processing = processMessage(message, context);
  await waitFor(() => keyWriteStarted);
  // Baileys ends its connection listeners while in-flight message work can still finish.
  t.mock.method(socket, "end", async () => {
    socket.ended = true;
    socket.ev.emit("connection.update", { connection: "close" });
    socket.ev.removeAllListeners("connection.update");
  });
  await fixture.client.disconnect();
  const savesAtStop = fixture.saves.length;
  gate.resolve();
  await processing;
  await flush();
  assert.equal(fixture.saves.length, savesAtStop);
});

/** Drain archive loading before reset and never start the next cache after a stop. */
test("disconnect drains archive initialization without starting poll cleanup", async (t) => {
  const fixture = await clientFixture(t, { registered: true, me: { id: `${PHONE}:7@s.whatsapp.net` } }, { connect: false });
  const gate = deferred();
  const realStat = fs.stat.bind(fs), realRm = fs.rm.bind(fs);
  let archiveStarted = false, pollRemovals = 0;
  t.mock.method(fs, "stat", (file, ...args) => {
    if (path.basename(file) === "chat-archive-cache.json") { archiveStarted = true; return gate.promise; }
    return realStat(file, ...args);
  });
  t.mock.method(fs, "rm", (file, ...args) => {
    if (path.basename(file) === "poll-cache.json.tmp") { pollRemovals += 1; return Promise.resolve(); }
    return realRm(file, ...args);
  });
  const connecting = fixture.client.connect();
  await waitFor(() => archiveStarted);
  let stopped = false;
  const stopping = fixture.client.disconnect().then(() => { stopped = true; });
  await flush();
  const stoppedBeforeLoad = stopped;
  gate.reject(Object.assign(new Error("Synthetic missing archive"), { code: "ENOENT" }));
  await Promise.all([connecting, stopping]);
  assert.equal(stoppedBeforeLoad, false);
  assert.equal(pollRemovals, 0);
  assert.equal(fixture.sockets.length, 0);
});

/** Let an already-started poll-cache cleanup finish before a replacement owns its directory. */
test("disconnect drains pending poll-cache cleanup before completing", async (t) => {
  const fixture = await clientFixture(t, { registered: true, me: { id: `${PHONE}:7@s.whatsapp.net` } }, { connect: false });
  const gate = deferred();
  const realRm = fs.rm.bind(fs);
  let cleanupStarted = false;
  t.mock.method(fs, "rm", (file, ...args) => {
    if (path.basename(file) === "poll-cache.json.tmp") { cleanupStarted = true; return gate.promise; }
    return realRm(file, ...args);
  });
  const connecting = fixture.client.connect();
  await waitFor(() => cleanupStarted);
  let stopped = false;
  const stopping = fixture.client.disconnect().then(() => { stopped = true; });
  await flush();
  const stoppedBeforeCleanup = stopped;
  gate.resolve();
  await Promise.all([connecting, stopping]);
  assert.equal(stoppedBeforeCleanup, false);
  assert.equal(stopped, true);
  assert.equal(fixture.sockets.length, 0);
});

/** Recover an interrupted phone attempt at startup without deleting the account directory. */
test("startup removes provisional identities left by an interrupted phone attempt", async (t) => {
  const fixture = await clientFixture(t, { registered: false, pairingCode: CODE, me: { id: `${PHONE}@s.whatsapp.net` } });
  assert.deepEqual(fixture.creds, { registered: false });
  assert.deepEqual(fixture.saves[0], { registered: false });
});

/** Keep a QR-linked identity when an earlier phone-code request left its code behind. */
test("startup keeps a linked identity when a QR scan followed a phone-code request", async (t) => {
  // QR pair-success stores the account and device identity but never sets registered.
  const account = { details: "fictional-account" };
  const me = { id: `${PHONE}:7@s.whatsapp.net` };
  const fixture = await clientFixture(t, { registered: false, pairingCode: CODE, account, me });
  assert.deepEqual(fixture.creds, { registered: false, account, me });
  assert.deepEqual(fixture.saves[0], { registered: false, account, me });
});

/** Preserve a QR scan that completes on a socket where a phone code was requested. */
test("a QR scan after a phone-code request survives the restart-required reconnect", async (t) => {
  const fixture = await clientFixture(t);
  fixture.sockets[0].ev.emit("connection.update", { qr: "fictional-qr-code" });
  await requestFreshCode(fixture);
  const socket = fixture.sockets[1];
  // Baileys merges pair-success into the same credentials before asking for a restart.
  const linked = { account: { details: "fictional-account" }, me: { id: `${PHONE}:7@s.whatsapp.net` } };
  Object.assign(fixture.creds, linked);
  socket.ev.emit("creds.update", linked);
  socket.ev.emit("connection.update", { isNewLogin: true });
  socket.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { statusCode: 515 } } });
  await fixture.client.connect();
  assert.equal(fixture.creds.me.id, `${PHONE}:7@s.whatsapp.net`);
  assert.equal(fixture.creds.pairingCode, undefined);
  assert.equal(fixture.saves.at(-1).me.id, `${PHONE}:7@s.whatsapp.net`);
});

/** Preserve successful phone linking across the restart-required socket replacement. */
test("successful phone pairing survives the subsequent reconnect", async (t) => {
  const fixture = await clientFixture(t);
  fixture.sockets[0].ev.emit("connection.update", { qr: "fictional-qr-code" });
  await requestFreshCode(fixture);
  const socket = fixture.sockets[1];
  Object.assign(fixture.creds, { registered: true, account: { details: "fictional-signed-account" },
    me: { id: `${PHONE}:7@s.whatsapp.net` } });
  socket.ev.emit("creds.update", fixture.creds);
  socket.ev.emit("connection.update", { isNewLogin: true });
  socket.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { statusCode: 515 } } });
  await fixture.client.connect();
  assert.equal(fixture.creds.registered, true);
  assert.equal(fixture.creds.me.id, `${PHONE}:7@s.whatsapp.net`);
  fixture.sockets[2].ev.emit("connection.update", { connection: "open" });
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

/** Keep each notification readable when the Home Assistant entry link cannot be discovered. */
test("notifications without a discovered link still read as sentences", async () => {
  const requests = [];
  const fixture = runtimeFixture({ httpClient: {
    get: async () => { throw new Error("Fictional Supervisor outage."); },
    post: async (url, body) => { requests.push({ url, body }); },
  } });
  fixture.accounts[0].emit("qr", "fictional-qr-code");
  await fixture.runtime.flushPairingNotifications();
  fixture.accounts[0].emit("pairing_update", { method: "phone", pending: true, code: null });
  await fixture.runtime.flushPairingNotifications();
  fixture.accounts[0].emit("pairing_update", { method: "phone", pending: false, code: "ABCD-1234" });
  await fixture.runtime.flushPairingNotifications();
  const [qr, generating, code] = requests.filter((request) => request.url.endsWith("/create")).map((request) => request.body.message);
  assert.match(qr, /Open the WhatsApp app's Web UI from its Home Assistant page\.$/);
  assert.match(generating, /Open the WhatsApp app's Web UI from its Home Assistant page\.$/);
  assert.match(code, /from its Home Assistant page to request a new code or return to QR pairing\.$/);
});

/** Dismiss a pairing notification once, rather than on every reconnect of a paired account. */
test("paired accounts do not repeat notification dismissals on reconnect", async () => {
  const fixture = runtimeFixture();
  const client = fixture.accounts[0];
  const notifications = () => fixture.requests
    .filter((request) => request.body.notification_id === "whatsapp_addon_qrcode_default")
    .map((request) => request.url.split("/").at(-1));
  client.emit("ready");
  await fixture.runtime.flushPairingNotifications();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    client.emit("disconnected", 428);
    await fixture.runtime.flushPairingNotifications();
    client.emit("pairing_update", { method: "qr", pending: false, code: null });
    client.emit("ready");
    await fixture.runtime.flushPairingNotifications();
  }
  // The first dismissal still clears a notification left by an earlier run.
  assert.deepEqual(notifications(), ["dismiss"]);
  client.emit("qr", "fictional-qr-code");
  await fixture.runtime.flushPairingNotifications();
  client.emit("ready");
  await fixture.runtime.flushPairingNotifications();
  assert.deepEqual(notifications(), ["dismiss", "create", "dismiss"]);
});

/** Replace a rotating QR in place, and remove only a QR that a long reconnect has left expired. */
test("a rotating QR socket keeps its notification until the next QR replaces it", async () => {
  const fixture = runtimeFixture();
  const client = fixture.accounts[0];
  const notifications = () => fixture.requests
    .filter((request) => request.body.notification_id === "whatsapp_addon_qrcode_default")
    .map((request) => request.url.split("/").at(-1));
  client.emit("qr", "fictional-first-qr");
  await fixture.runtime.flushPairingNotifications();
  // Baileys ends an unscanned QR socket with 408; closing its pairing session comes first.
  client.emit("pairing_update", { method: "qr", pending: false, code: null });
  client.emit("disconnected", 408);
  await fixture.runtime.flushPairingNotifications();
  assert.deepEqual(notifications(), ["create"]);
  client.emit("qr", "fictional-second-qr");
  await fixture.runtime.flushPairingNotifications();
  assert.deepEqual(notifications(), ["create", "create"]);
  fixture.runtime.clientStates.default.lastQrAt = new Date(Date.now() - 61_000).toISOString();
  client.emit("disconnected", 428);
  await fixture.runtime.flushPairingNotifications();
  assert.deepEqual(notifications(), ["create", "create", "dismiss"]);
});

/** Keep pairing notifications prompt while Supervisor cannot describe the installed app. */
test("a failed link lookup is retried only after a pause", async () => {
  let now = Date.parse("2026-10-26T08:00:00Z");
  const lookups = [];
  const fixture = runtimeFixture({ nowDate: () => new Date(now), httpClient: {
    get: async (url) => { lookups.push(url); throw new Error("Fictional Supervisor outage."); },
    post: async () => {},
  } });
  for (const qr of ["first", "second", "third"]) {
    fixture.accounts[0].emit("qr", `fictional-${qr}-qr`);
    await fixture.runtime.flushPairingNotifications();
  }
  assert.equal(lookups.length, 2);
  now += 5 * 60_000;
  fixture.accounts[0].emit("qr", "fictional-later-qr");
  await fixture.runtime.flushPairingNotifications();
  assert.equal(lookups.length, 4);
});

/** Count only generated codes toward the cooldown, so a failed request can be retried at once. */
test("a failed code request does not start the 30 second cooldown", async () => {
  const fixture = runtimeFixture();
  const client = fixture.accounts[0];
  client.emit("qr", "fictional-qr-code");
  const deliver = client.requestPairingCode;
  client.requestPairingCode = async () => { throw new Error("Fictional upstream failure."); };
  await assert.rejects(fixture.runtime.requestPairingCode("default", PHONE), { code: "pairing_failed", status: 502 });
  client.requestPairingCode = deliver;
  await fixture.runtime.requestPairingCode("default", PHONE);
  await assert.rejects(fixture.runtime.requestPairingCode("default", PHONE), { status: 429 });
});

/** Show a code from the fresh socket even though the QR socket disconnected to make room for it. */
test("a phone code returns the account to pairing after its fresh socket connects", async () => {
  const fixture = runtimeFixture();
  fixture.accounts[0].emit("qr", "fictional-qr-code");
  fixture.accounts[0].emit("disconnected", null);
  assert.equal(fixture.runtime.clientStates.default.state, "reconnecting");
  fixture.accounts[0].emit("pairing_update", { method: "phone", pending: false, code: "ABCD-1234" });
  await fixture.runtime.flushPairingNotifications();
  assert.equal(fixture.runtime.clientStates.default.state, "pairing");
  assert.equal(fixture.runtime.clientStates.default.pairingCode, "ABCD-1234");
  const notification = fixture.requests.filter((request) => request.body.notification_id === "whatsapp_addon_qrcode_default").at(-1);
  assert.ok(notification.url.endsWith("/create"));
  assert.match(notification.body.message, /ABCD-1234/);
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
  fixture.accounts[0].emit("pairing_update", { method: "phone", pending: false, code: "ABCD-1234" });
  assert.equal(fixture.runtime.clientStates.default.state, "recovery_paused");
  await fixture.runtime.flushPairingNotifications();
  const notifications = fixture.requests.filter((request) => request.body.notification_id === "whatsapp_addon_qrcode_default");
  assert.ok(notifications.at(-1).url.endsWith("/dismiss"));
});

/** Clear notifications from a previous run even when recovery prevents accounts from starting. */
test("recovery-paused startup dismisses stale pairing notifications", async () => {
  const notifications = new Map([
    ["whatsapp_addon_qrcode_default", { message: "Fictional previous pairing code" }],
    ["whatsapp_addon_qrcode_backup", { message: "Fictional previous QR image" }],
  ]);
  const fixture = runtimeFixture({
    initialRecoveryRecord: { active: true, reason: "libsignal_decrypt_storm", detected_at: "2026-10-26T10:00:00.000Z" },
    httpClient: {
      get: async () => assert.fail("Paused accounts do not need a pairing link lookup."),
      post: async (url, body) => {
        if (url.endsWith("/dismiss")) notifications.delete(body.notification_id);
        if (url.endsWith("/create")) notifications.set(body.notification_id, body);
      },
    },
  });
  await fixture.runtime.reportRecoveryRequired();
  await fixture.runtime.flushPairingNotifications();
  assert.equal(fixture.accounts.length, 0);
  assert.equal(notifications.has("whatsapp_addon_qrcode_default"), false);
  assert.equal(notifications.has("whatsapp_addon_qrcode_backup"), false);
  assert.equal(notifications.has("whatsapp_addon_recovery_required"), true);
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
