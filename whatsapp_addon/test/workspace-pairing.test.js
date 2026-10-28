/** Exercise the shipped workspace and template with fictional account and transport data. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { normalizePairingPhone, request } = require("../webui/workspace");

const PHONE = "12025550123";
const CODE = "ABCD-1234";
const QR = "data:image/png;base64,c3ludGhldGlj";

/** Model only browser tree and event APIs used by the production workspace. */
class Element {
  /** Create a detached node and its mutable browser properties. */
  constructor(tag, document) {
    this.tagName = tag; this.document = document; this.children = []; this.attributes = {};
    this.dataset = {}; this.listeners = {}; this.className = ""; this.hidden = false;
    this.disabled = false; this.value = ""; this.paused = true; this.content = "";
    this.classList = { toggle: (name, enabled) => {
      const names = new Set(this.className.split(/\s+/));
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(" ");
    } };
  }
  /** Read combined child text as a browser node would expose it. */
  get textContent() { return this.content + this.children.map(node => node.textContent).join(""); }
  /** Replace descendants when production code assigns plain text. */
  set textContent(value) { this.children = []; this.content = String(value); }
  /** Reflect fixed template attributes into the properties used by the app. */
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") this.document.ids.set(value, this);
    if (name === "class") this.className = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    if (["hidden", "disabled"].includes(name)) this[name] = true;
  }
  /** Read an explicitly present attribute, including a rendered image source. */
  getAttribute(name) { return name === "src" ? this.src ?? null : this.attributes[name] ?? null; }
  /** Remove stale secret URLs and semantic attributes. */
  removeAttribute(name) { delete this.attributes[name]; if (name === "src") delete this.src; }
  /** Append existing or freshly created tree nodes. */
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  /** Replace a region without replacing its owning control. */
  replaceChildren(...nodes) { this.children = []; this.content = ""; this.append(...nodes); }
  /** Insert keyed recording nodes at their real list position. */
  insertBefore(node, before) { node.parent = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node); }
  /** Remove an account or recording retired by the server snapshot. */
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  /** Find the limited trusted selector forms used by the shipped workspace. */
  querySelectorAll(selector) {
    const last = selector.split(" ").at(-1);
    const matches = node => last.startsWith(".") ? node.className.split(/\s+/).includes(last.slice(1))
      : last.startsWith("[") ? Object.hasOwn(node.attributes, last.slice(1, -1)) : node.tagName === last;
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  /** Return a unique account subcontrol. */
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  /** Register the actual production event listener. */
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  /** Dispatch user input without bypassing production event handlers. */
  dispatch(type) { for (const listener of this.listeners[type] || []) listener({ target: this, preventDefault() {} }); }
  /** Resolve delegated root button clicks. */
  closest(tag) { return this.tagName === tag ? this : this.parent?.closest(tag); }
  /** Keep focus observable across validation and polling. */
  focus() { this.document.activeElement = this; }
  /** Retain the native audio contract without playing anything. */
  pause() { this.paused = true; }
}

/** Parse production IDs and control nesting rather than maintaining a second UI template. */
function documentFixture() {
  const document = { ids: new Map(), hidden: false, addEventListener() {},
    createElement: tag => new Element(tag, document), createElementNS: (_namespace, tag) => new Element(tag, document),
    createTextNode: text => { const node = new Element("#text", document); node.textContent = text; return node; },
    getElementById: id => document.ids.get(id) };
  const root = new Element("document", document), stack = [root];
  const html = fs.readFileSync(path.join(__dirname, "../webui/workspace.html"), "utf8").replace("{{INITIAL_VIEW}}", "connection");
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9-]*)([^>]*)>/gi)) {
    const [, tag, attributes] = match;
    if (match[0].startsWith("</")) { if (stack.at(-1).tagName === tag) stack.pop(); continue; }
    const node = new Element(tag, document);
    for (const attribute of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attribute[1], attribute[2] ?? "");
    stack.at(-1).append(node);
    if (!["meta", "base", "link", "input", "img", "hr"].includes(tag)) stack.push(node);
  }
  return document;
}

/** Settle the real script's asynchronous request, render, and refresh continuations. */
async function settle() { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); }

/** Boot the actual workspace script against controllable offline HTTP responses. */
async function workspaceFixture(setup) {
  const document = documentFixture(), posts = [], timers = [];
  const fixture = { document, posts, timers, failStatus: false, search: "",
    status: { clients: ["default", "backup"].map(id => ({ id, state: "pairing", pairingMethod: "qr", qrDataUrl: QR })), pairing_methods: { qr: true, code: true }, recovery: { active: false } },
    voice: { client_id: "default", active: true, state: "connected", configured: true, live_mode: true, connected: true },
    onAction: async () => ({ ok: true, json: async () => ({ status: "pairing_started" }) }) };
  setup?.(fixture);
  const location = new URL("http://example.invalid/api/hassio_ingress/synthetic/" + fixture.search);
  const context = { document, URL, URLSearchParams, AbortController,
    window: { location, history: { replaceState() {} } },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; }, clearTimeout() {},
    fetch: async (endpoint, options) => {
      if (options.method === "POST") { posts.push({ endpoint, options }); return fixture.onAction(endpoint, options); }
      if (endpoint === "api/status") { if (fixture.failStatus) throw new TypeError("Synthetic offline status"); return fixture.onStatus ? fixture.onStatus() : { ok: true, json: async () => structuredClone(fixture.status) }; }
      if (endpoint === "voice/status") return { ok: true, json: async () => structuredClone(fixture.voice) };
      return { ok: true, json: async () => ({ recordings: [] }) };
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../webui/workspace.js"), "utf8"), context);
  fixture.node = id => document.getElementById(id);
  fixture.click = async id => { fixture.node(id).dispatch("click"); await settle(); };
  fixture.refresh = () => fixture.click("refresh");
  fixture.select = async id => { fixture.node("accounts").children.find(node => node.getAttribute("aria-label").startsWith(id + ",")).dispatch("click"); await settle(); };
  fixture.typePhone = value => { fixture.node("pairing-phone").value = value; fixture.node("pairing-phone").dispatch("input"); };
  fixture.submit = async () => { fixture.node("pairing-phone-form").dispatch("submit"); await settle(); };
  await settle();
  return fixture;
}

/** Home Assistant opens the app without an account, so the page must find the one to pair. */
test("the Connection view first opens the account waiting to pair, not the calling account", async () => {
  const connectDefault = fixture => { Object.assign(fixture.status.clients[0], { state: "connected", qrDataUrl: null }); };
  const ui = await workspaceFixture(connectDefault);
  assert.equal(ui.node("account-title").textContent, "backup");
  assert.equal(ui.node("pairing").hidden, false);
  assert.equal(ui.node("pairing-qr").getAttribute("src"), QR);
  const calls = await workspaceFixture(fixture => { connectDefault(fixture); fixture.search = "?view=calls"; });
  assert.equal(calls.node("account-title").textContent, "default");
  // A later pairing never moves an account the page already shows.
  const settled = await workspaceFixture(fixture => { for (const client of fixture.status.clients) Object.assign(client, { state: "connected", qrDataUrl: null }); });
  Object.assign(settled.status.clients[1], { state: "pairing", qrDataUrl: QR }); await settled.refresh();
  assert.equal(settled.node("account-title").textContent, "default");
});

/** Mirror the accepted international input contract without accepting arbitrary recipient IDs. */
test("phone pairing input accepts formatting and rejects local numbers, URLs, and IDs", () => {
  assert.equal(normalizePairingPhone("+1 (202) 555-0123"), PHONE);
  for (const value of ["02025550123", "123", `${PHONE}@s.whatsapp.net`, "1e10", "https://example.invalid", "+1/202/5550123"]) assert.throws(() => normalizePairingPhone(value), TypeError);
});

/** Exercise selection and draft retention through the real rendered controls and polling. */
test("phone selection is explicit and drafts survive account switches and reconnect gaps", async () => {
  const ui = await workspaceFixture();
  await ui.click("choose-phone"); ui.typePhone("+1 (202) 555-0123");
  assert.equal(ui.posts.length, 0);
  await ui.refresh(); assert.equal(ui.node("pairing-phone").value, "+1 (202) 555-0123");
  await ui.select("backup"); await ui.click("choose-phone"); ui.typePhone("+44 7700 900123");
  await ui.select("default"); assert.equal(ui.node("pairing-phone").value, "+1 (202) 555-0123");
  ui.status.clients[0].state = "reconnecting"; await ui.refresh();
  assert.equal(ui.node("pairing-phone-panel").hidden, false);
  assert.equal(ui.node("generate-pairing-code").disabled, true);
  assert.equal(ui.node("pairing-phone").value, "+1 (202) 555-0123");
  ui.status.clients[0].state = "pairing"; await ui.refresh();
  assert.equal(ui.node("generate-pairing-code").disabled, false);
  Object.assign(ui.status.clients[0], { pairingMethod: "phone", pairingCode: CODE }); await ui.refresh();
  await ui.click("new-pairing-code"); ui.typePhone(PHONE);
  Object.assign(ui.status.clients[0], { state: "connecting", pairingMethod: "qr", pairingCode: null }); await ui.refresh();
  assert.equal(ui.node("pairing-phone-panel").hidden, false);
  assert.equal(ui.node("pairing-phone").value, PHONE);
});

/** Keep a slow pairing request separate from account navigation and global call controls. */
test("pending code requests remain scoped to their account and never block Hang up", async () => {
  const ui = await workspaceFixture(); let release;
  ui.onAction = () => new Promise(resolve => { release = resolve; });
  await ui.click("choose-phone"); ui.typePhone(PHONE); await ui.submit();
  assert.equal(ui.node("generate-pairing-code").disabled, true);
  assert.equal(ui.node("global-hangup").disabled, false);
  assert.equal(ui.posts[0].endpoint, "api/pairing/phone");
  assert.equal(ui.posts[0].options.headers["x-whatsapp-pairing"], "1");
  assert.deepEqual(JSON.parse(ui.posts[0].options.body), { clientId: "default", phoneNumber: PHONE });
  assert.ok(ui.timers.some(timer => timer.delay === 30000));
  await ui.select("backup"); await ui.click("choose-phone"); ui.typePhone("+44 7700 900123");
  Object.assign(ui.status.clients[0], { pairingMethod: "phone", pairingCode: CODE });
  release({ ok: true, json: async () => ({ status: "pairing_started" }) }); await settle();
  assert.equal(ui.node("pairing-phone").value, "+44 7700 900123");
  assert.equal(ui.node("pairing-code").textContent, "");
  await ui.select("default"); assert.equal(ui.node("pairing-code").textContent, CODE);
});

/** Prevent a pre-action poll from restoring a retired code while the follow-up poll is skipped. */
test("a delayed poll cannot restore the code replaced by a completed pairing action", async () => {
  const ui = await workspaceFixture();
  Object.assign(ui.status.clients[0], { pairingMethod: "phone", pairingCode: CODE }); await ui.refresh();
  await ui.click("new-pairing-code"); ui.typePhone(PHONE);
  const stale = structuredClone(ui.status); let releasePoll;
  ui.onStatus = () => new Promise(resolve => { releasePoll = resolve; });
  await ui.refresh();
  ui.onAction = async () => {
    ui.status.clients[0].pairingCode = "NEXT-5678";
    return { ok: true, json: async () => ({ status: "pairing_started" }) };
  };
  await ui.submit();
  releasePoll({ ok: true, json: async () => stale }); await settle();
  assert.equal(ui.node("pairing-code").textContent, "");
  assert.equal(ui.node("generate-pairing-code").disabled, true);
  delete ui.onStatus; await ui.refresh();
  assert.equal(ui.node("pairing-code").textContent, "NEXT-5678");
});

/** A rejected or abandoned request for another code must not hide the code that still works. */
test("requesting another code keeps the current code until a new one replaces it", async () => {
  const ui = await workspaceFixture();
  Object.assign(ui.status.clients[0], { pairingMethod: "phone", pairingCode: CODE }); await ui.refresh();
  assert.equal(ui.node("keep-pairing-code").hidden, true);
  await ui.click("new-pairing-code");
  assert.equal(ui.node("pairing-phone-form").hidden, false);
  assert.equal(ui.node("pairing-code-panel").hidden, false);
  assert.equal(ui.node("pairing-code").textContent, CODE);
  assert.equal(ui.node("new-pairing-code").hidden, true);
  assert.equal(ui.document.activeElement, ui.node("pairing-phone"));
  const cooldown = "Wait 30 seconds before requesting another pairing code.";
  ui.onAction = async () => ({ ok: false, status: 429, json: async () => ({ error: { code: "pairing_rate_limited", message: cooldown } }) });
  ui.typePhone(PHONE); await ui.submit();
  assert.equal(ui.node("pairing-error").textContent, cooldown);
  assert.equal(ui.node("pairing-code").textContent, CODE);
  assert.equal(ui.node("pairing-phone").value, PHONE);
  await ui.click("keep-pairing-code");
  assert.equal(ui.node("pairing-phone-form").hidden, true);
  assert.equal(ui.node("pairing-error").hidden, true);
  assert.equal(ui.node("pairing-code").textContent, CODE);
  assert.equal(ui.node("new-pairing-code").hidden, false);
  assert.equal(ui.document.activeElement, ui.node("new-pairing-code"));
});

/** Preserve the user's input and show useful failures from a non-JSON ingress response. */
test("failed phone requests retain their draft and recover after an HTML proxy error", async () => {
  const ui = await workspaceFixture();
  ui.onAction = async () => ({ ok: false, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  await ui.click("choose-phone"); ui.typePhone(PHONE); await ui.submit();
  assert.equal(ui.node("pairing-phone").value, PHONE);
  assert.equal(ui.node("pairing-error").textContent, "The pairing request failed. Try again.");
  assert.equal(ui.node("generate-pairing-code").disabled, false);
  await ui.refresh(); assert.equal(ui.node("pairing-phone").value, PHONE);
});

/** Remove QR and code secrets whenever the latest account state cannot vouch for them. */
test("status failure, success, recovery, and account removal clear displayed pairing secrets", async () => {
  const ui = await workspaceFixture();
  Object.assign(ui.status.clients[0], { pairingMethod: "phone", pairingCode: CODE }); await ui.refresh();
  assert.equal(ui.node("pairing-code").textContent, CODE);
  ui.failStatus = true; await ui.refresh();
  assert.equal(ui.node("pairing-code").textContent, ""); assert.equal(ui.node("pairing-qr").getAttribute("src"), null);
  assert.equal(ui.node("generate-pairing-code").disabled, true);
  ui.failStatus = false; await ui.refresh(); assert.equal(ui.node("pairing-code").textContent, CODE);
  ui.status.clients[0].state = "connected"; await ui.refresh(); assert.equal(ui.node("pairing-code").textContent, "");
  ui.status.clients[0].state = "pairing"; ui.status.recovery.active = true; await ui.refresh();
  assert.equal(ui.node("pairing-code").textContent, ""); assert.equal(ui.node("pairing-qr").getAttribute("src"), null);
  ui.status.recovery.active = false; ui.status.clients.shift(); await ui.refresh();
  assert.equal(ui.node("pairing-code").textContent, "");
});

/** Request a fresh QR only when switching away from an existing phone-code session. */
test("returning from a phone code invokes the QR action and removes the old code", async () => {
  const ui = await workspaceFixture();
  Object.assign(ui.status.clients[0], { pairingMethod: "phone", pairingCode: CODE }); await ui.refresh();
  ui.onAction = async endpoint => {
    assert.equal(endpoint, "api/pairing/qr"); Object.assign(ui.status.clients[0], { pairingMethod: "qr", pairingCode: null });
    return { ok: true, json: async () => ({ status: "pairing_started" }) };
  };
  await ui.click("choose-qr");
  assert.equal(ui.node("pairing-code").textContent, ""); assert.equal(ui.node("pairing-qr-panel").hidden, false);
  assert.deepEqual(JSON.parse(ui.posts[0].options.body), { clientId: "default" });
});

/** Apply an explicit code-action timeout without retrying an uncertain operation. */
test("phone action timeouts keep the pairing header and explain status recovery", async t => {
  let deadline, calls = 0;
  t.mock.method(globalThis, "setTimeout", callback => { deadline = callback; return 1; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  t.mock.method(globalThis, "fetch", (_endpoint, options) => {
    calls++; assert.equal(options.headers["x-whatsapp-pairing"], "1");
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { const error = new Error(); error.name = "AbortError"; reject(error); }));
  });
  const pending = request("api/pairing/phone", { clientId: "default", phoneNumber: PHONE }); deadline();
  await assert.rejects(pending, /Refresh status before trying again; the request may still be running/); assert.equal(calls, 1);
});
