const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createIngressGuard, createStatusSnapshot, createWebUiApp,
  isIngressProxyAddress, normalizeBaseHref, normalizeRequestUrl, renderWebUi,
} = require("../webui");
const { RecoveryActionError } = require("../recovery");

/** Start an isolated loopback ingress app and close it after the HTTP test. */
async function serve(t, options = {}) {
  const app = createWebUiApp({ clients: {}, clientStates: {},
    allowedIngressAddress: "127.0.0.1", ...options });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("ingress trusts the peer address rather than forwarded headers", () => {
  assert.equal(isIngressProxyAddress("172.30.32.2"), true);
  assert.equal(isIngressProxyAddress("::ffff:172.30.32.2"), true);
  assert.equal(isIngressProxyAddress("127.0.0.1"), false);
  const response = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
  let allowed = false;
  const guard = createIngressGuard();
  guard({ socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-forwarded-for": "172.30.32.2" } }, response,
  () => { allowed = true; });
  assert.equal(allowed, false);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body, "Forbidden");
  guard({ socket: { remoteAddress: "172.30.32.2" } }, response,
    () => { allowed = true; });
  assert.equal(allowed, true);
});

test("status joins account state and advertises pairing methods without exposing internals", () => {
  const snapshot = createStatusSnapshot({
    clients: { default: { sessionSecret: "synthetic-private-value" }, backup: {} },
    clientStates: {
      default: { state: "pairing", lastQrAt: "2026-06-01T00:00:00.000Z",
        qrDataUrl: "data:image/png;base64,synthetic-placeholder",
        sessionSecret: "synthetic-private-value" },
      old: { state: "connected", connectedAt: "2026-06-01T00:01:00.000Z" },
    },
  });
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.client_count, 3);
  assert.deepEqual(snapshot.clients.map((client) => client.id), ["backup", "default", "old"]);
  assert.equal(snapshot.clients[0].state, "connecting");
  assert.equal(snapshot.clients[1].state, "pairing");
  assert.equal(snapshot.clients[1].qrDataUrl, "data:image/png;base64,synthetic-placeholder");
  assert.equal(snapshot.clients[2].connectedAt, "2026-06-01T00:01:00.000Z");
  assert.equal(JSON.stringify(snapshot).includes("synthetic-private-value"), false);
  assert.deepEqual(snapshot.pairing_methods, { qr: true, code: true });
  assert.deepEqual(snapshot.recovery, { active: false, reason: null, detectedAt: null,
    failedDecryptMessages: 0, sessionErrors: 0, operationPending: false });
});

test("status retains pending recovery and failure details", () => {
  const snapshot = createStatusSnapshot({ clients: {},
    clientStates: { default: { state: "recovery_paused" } },
    recovery: { active: true, reason: "libsignal_decrypt_storm",
      detectedAt: "2026-08-26T12:00:00.000Z", failedDecryptMessages: 10,
      badMacSessionErrors: 100, messageCounterSessionErrors: 2, operationPending: true },
  });
  assert.equal(snapshot.status, "recovery_paused");
  assert.equal(snapshot.recovery.sessionErrors, 102);
  assert.equal(snapshot.recovery.operationPending, true);
  assert.equal(snapshot.clients[0].state, "recovery_paused");
});

test("ingress path normalization keeps navigation local", () => {
  assert.equal(normalizeRequestUrl("//api/status"), "/api/status");
  assert.equal(normalizeRequestUrl("/api/status"), "/api/status");
  assert.equal(normalizeBaseHref(""), "./");
  assert.equal(normalizeBaseHref("/api/hassio_ingress/synthetic"), "/api/hassio_ingress/synthetic/");
  assert.equal(normalizeBaseHref("/api/hassio_ingress/synthetic/"), "/api/hassio_ingress/synthetic/");
  assert.equal(normalizeBaseHref("//example.invalid/bad"), "./");
  assert.equal(normalizeBaseHref("https://example.invalid/bad"), "./");
  for (const value of ["api/hassio_ingress/synthetic", "javascript:alert(1)",
    "/\\example.invalid", "/api/hassio_ingress/synthetic?next=outside",
    "/api/hassio_ingress/synthetic#fragment", "/api/hassio_ingress/has space",
    "/api/hassio_ingress/has\nnewline", "/api/hassio_ingress/has\0control",
    "/api/hassio_ingress/colon:value"]) {
    assert.equal(normalizeBaseHref(value), "./");
  }
});

test("renderer loads its script and stylesheet from the ingress base", () => {
  const html = renderWebUi({ ingressPath: "/api/hassio_ingress/synthetic" });
  assert.match(html, /<title>WhatsApp Add-on<\/title>/);
  assert.match(html, /<base href="\/api\/hassio_ingress\/synthetic\/">/);
  assert.match(html, /<script\b[^>]*src="assets\/workspace\.js"/);
  assert.match(html, /<link\b[^>]*href="assets\/workspace\.css"/);
  assert.match(html, /data-initial-view="connection"/);
});

test("renderer allowlists its initial view and escapes the ingress header", () => {
  for (const initialView of ["connection", "calls", "recordings"]) {
    assert.match(renderWebUi({ initialView }), new RegExp(`data-initial-view="${initialView}"`));
  }
  const payload = '\"><script>alert("synthetic")</script>';
  const html = renderWebUi({ ingressPath: "/api/hassio_ingress/" + payload,
    initialView: payload });
  assert.match(html, /data-initial-view="connection"/);
  assert.equal(html.includes(payload), false);
  assert.equal(html.includes('<script>alert("synthetic")</script>'), false);
});

test("renderer preserves literal replacement characters in a valid ingress segment", () => {
  const html = renderWebUi({ ingressPath: "/api/hassio_ingress/synthetic$&segment" });
  assert.ok(html.includes('<base href="/api/hassio_ingress/synthetic$&amp;segment/">'));
  assert.equal(html.includes("{{BASE_HREF}}"), false);
});

test("workspace page, status, and real assets are no-store ingress resources", async (t) => {
  const base = await serve(t, { clientStates: { default: { state: "connecting" } } });
  const response = await fetch(`${base}/`, {
    headers: { "x-ingress-path": "/api/hassio_ingress/synthetic" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /<base href="\/api\/hassio_ingress\/synthetic\/">/);
  const status = await fetch(`${base}/api/status`);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal((await status.json()).clients[0].state, "connecting");
  for (const [asset, mime] of [["workspace.js", /javascript/], ["workspace.css", /text\/css/]]) {
    const resource = await fetch(`${base}/assets/${asset}`);
    assert.equal(resource.status, 200);
    assert.match(resource.headers.get("content-type"), mime);
    assert.equal(resource.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await resource.text(), /^\s*<!doctype html>/i);
  }
});

test("untrusted peers cannot read workspace assets or status or invoke recovery", async (t) => {
  let invoked = false;
  const base = await serve(t, { allowedIngressAddress: "172.30.32.2",
    retryRecovery: async () => { invoked = true; } });
  for (const resource of ["/", "/api/status", "/assets/workspace.js", "/assets/workspace.css"]) {
    const response = await fetch(base + resource,
      { headers: { "x-forwarded-for": "172.30.32.2" } });
    assert.equal(response.status, 403);
  }
  const response = await fetch(`${base}/api/recovery/retry`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 403);
  assert.equal(invoked, false);
});

test("recovery routes retain retry and exact-account confirmation payloads", async (t) => {
  const actions = [];
  const base = await serve(t, {
    clientStates: { default: { state: "recovery_paused" } },
    recovery: { active: true, reason: "libsignal_decrypt_storm" },
    retryRecovery: async () => actions.push(["retry"]),
    resetRecoveryClient: async (...args) => actions.push(["reset", ...args]),
  });
  let response = await fetch(`${base}/api/recovery/retry`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "retry_started" });
  response = await fetch(`${base}/api/recovery/reset`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "default", confirmation: "default" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "pairing_started" });
  assert.deepEqual(actions, [["retry"], ["reset", "default", "default"]]);
});

test("recovery validation failures stay structured and do not execute an action", async (t) => {
  let invoked = false;
  const base = await serve(t, { resetRecoveryClient: async () => {
    invoked = true;
    throw new RecoveryActionError(409, "recovery_not_active", "Recovery is not active.");
  } });
  for (const body of ["[]", "{invalid"]) {
    const response = await fetch(`${base}/api/recovery/reset`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_request");
  }
  assert.equal(invoked, false);
  const response = await fetch(`${base}/api/recovery/reset`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "default", confirmation: "default" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "recovery_not_active");
});

test("missing recovery callbacks fail safely", async (t) => {
  const base = await serve(t);
  for (const endpoint of ["retry", "reset"]) {
    const response = await fetch(`${base}/api/recovery/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "recovery_unavailable");
  }
});
