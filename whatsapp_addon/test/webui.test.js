const assert = require("assert");

const {
  createIngressGuard,
  createStatusSnapshot,
  isIngressProxyAddress,
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
};

const testRenderWebUi = () => {
  const html = renderWebUi();

  assert.ok(html.includes("<title>WhatsApp Add-on</title>"));
  assert.ok(html.includes('src="assets/logo.png"'));
  assert.ok(html.includes('fetch("api/status"'));
};

testIngressAddressGuard();
testIngressMiddleware();
testStatusSnapshot();
testRenderWebUi();

console.log("webui tests passed");
