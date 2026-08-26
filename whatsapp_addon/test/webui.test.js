const assert = require("assert");

const {
  createIngressGuard,
  createStatusSnapshot,
  createWebUiApp,
  isIngressProxyAddress,
  normalizeBaseHref,
  normalizeRequestUrl,
  renderWebUi,
} = require("../webui");

const testIngressAddressGuard = () => {
  assert.strictEqual(isIngressProxyAddress("172.30.32.2"), true);
  assert.strictEqual(isIngressProxyAddress("::ffff:172.30.32.2"), true);
  assert.strictEqual(isIngressProxyAddress("127.0.0.1"), false);
};

const testIngressMiddleware = () => {
  const guard = createIngressGuard();
  let nextCalled = false;
  const response = {
    statusCode: undefined,
    typeValue: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.typeValue = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };

  guard(
    { socket: { remoteAddress: "127.0.0.1" } },
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(response.statusCode, 403);
  assert.strictEqual(response.typeValue, "text/plain");
  assert.strictEqual(response.body, "Forbidden");

  guard(
    { socket: { remoteAddress: "172.30.32.2" } },
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.strictEqual(nextCalled, true);
};

const testStatusSnapshot = () => {
  const snapshot = createStatusSnapshot({
    clients: {
      default: {},
      backup: {},
    },
    clientStates: {
      default: {
        state: "pairing",
        lastQrAt: "2026-06-01T00:00:00.000Z",
        qrDataUrl: "data:image/png;base64,abc",
      },
      old: {
        state: "connected",
        connectedAt: "2026-06-01T00:01:00.000Z",
      },
    },
  });

  assert.strictEqual(snapshot.status, "ok");
  assert.strictEqual(snapshot.client_count, 3);
  assert.deepStrictEqual(
    snapshot.clients.map((client) => client.id),
    ["backup", "default", "old"]
  );
  assert.strictEqual(snapshot.clients[0].state, "connecting");
  assert.strictEqual(snapshot.clients[1].state, "pairing");
  assert.strictEqual(snapshot.clients[1].qrDataUrl, "data:image/png;base64,abc");
  assert.strictEqual(snapshot.clients[2].connectedAt, "2026-06-01T00:01:00.000Z");
  assert.deepStrictEqual(snapshot.recovery, {
    active: false,
    reason: null,
    detectedAt: null,
    failedDecryptMessages: 0,
    sessionErrors: 0,
    operationPending: false,
  });

  const paused = createStatusSnapshot({
    clients: {},
    clientStates: { default: { state: "recovery_paused" } },
    recovery: {
      active: true,
      reason: "libsignal_decrypt_storm",
      detectedAt: "2026-08-26T12:00:00.000Z",
      failedDecryptMessages: 10,
      badMacSessionErrors: 100,
      messageCounterSessionErrors: 2,
      operationPending: true,
    },
  });
  assert.strictEqual(paused.status, "recovery_paused");
  assert.strictEqual(paused.recovery.sessionErrors, 102);
  assert.strictEqual(paused.recovery.operationPending, true);
};

const testPathNormalization = () => {
  assert.strictEqual(normalizeRequestUrl("//"), "/");
  assert.strictEqual(normalizeRequestUrl("//api/status"), "/api/status");
  assert.strictEqual(normalizeRequestUrl("/api/status"), "/api/status");
  assert.strictEqual(normalizeBaseHref(""), "./");
  assert.strictEqual(normalizeBaseHref("/api/hassio_ingress/token"), "/api/hassio_ingress/token/");
  assert.strictEqual(normalizeBaseHref("/api/hassio_ingress/token/"), "/api/hassio_ingress/token/");
  assert.strictEqual(normalizeBaseHref("//example.com/bad"), "./");
};

const testRenderWebUi = () => {
  const html = renderWebUi({ ingressPath: "/api/hassio_ingress/token" });

  assert.ok(html.includes("<title>WhatsApp Add-on</title>"));
  assert.ok(html.includes('<base href="/api/hassio_ingress/token/">'));
  assert.ok(html.includes('src="assets/logo.png"'));
  assert.ok(html.includes('fetch("api/status"'));
  assert.ok(html.includes("Retry connection"));
  assert.ok(html.includes("and re-pair"));
};

const listen = (app) =>
  new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });

const close = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

const testRecoveryRoutes = async () => {
  const actions = [];
  const app = createWebUiApp({
    clients: {},
    clientStates: { default: { state: "recovery_paused" } },
    recovery: { active: true, reason: "libsignal_decrypt_storm" },
    retryRecovery: async () => actions.push(["retry"]),
    resetRecoveryClient: async (...args) => actions.push(["reset", ...args]),
    allowedIngressAddress: "127.0.0.1",
  });
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${baseUrl}/api/recovery/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { status: "retry_started" });

    response = await fetch(`${baseUrl}/api/recovery/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "default", confirmation: "default" }),
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { status: "pairing_started" });
    assert.deepStrictEqual(actions, [
      ["retry"],
      ["reset", "default", "default"],
    ]);
  } finally {
    await close(server);
  }
};

const main = async () => {
  testIngressAddressGuard();
  testIngressMiddleware();
  testStatusSnapshot();
  testPathNormalization();
  testRenderWebUi();
  await testRecoveryRoutes();

  console.log("webui tests passed");
};

void main();
