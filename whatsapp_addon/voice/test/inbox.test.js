"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { baseRequire } = require("../base");
const { startVoiceApp } = require("../app");
const { startAddon } = baseRequire("./runtime");

const message = (id) => ({
  key: { id, remoteJid: "12025550123@s.whatsapp.net", fromMe: false },
  type: "conversation",
  messageTimestamp: 1234567890,
  message: { conversation: "Fictional inbox test message" },
});

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "The expected inbox work was not scheduled");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deliveryClock() {
  const pending = [];
  return {
    pending,
    setTimeoutFn(fn, delay) {
      const timer = { fn, delay, unref() {} };
      pending.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
    async next() {
      await waitFor(() => pending.length > 0);
      const timer = pending.shift();
      await timer.fn();
      return timer.delay;
    },
  };
}

/** Start the real app and queue with only WhatsApp and Supervisor replaced. */
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-voice-inbox-"));
  const apps = [];
  const requests = [];
  const accepted = [];
  const errors = [];
  let ready = true;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/core/api/whatsapp/inbox") {
      if (!ready) {
        response.writeHead(503).end(JSON.stringify({ ready: false }));
        return;
      }
      if (request.method === "POST") {
        accepted.push(body);
        response.end(JSON.stringify({ delivered: body.id }));
        return;
      }
      response.end(JSON.stringify({ ready: true }));
      return;
    }
    response.end("{}");
  });
  t.after(async () => {
    for (const app of apps) await app.close();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = baseRequire("axios").create({ proxy: false, timeout: 1000 });
  transport.interceptors.request.use((config) => {
    const url = new URL(config.url);
    assert.equal(url.hostname, "supervisor");
    config.url = origin + url.pathname;
    return config;
  });

  const snapshot = async () => {
    try {
      return JSON.parse(await fs.readFile(path.join(directory, "inbox", "messages.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { pending: [], delivered: [] };
    }
  };
  return {
    accepted, requests, errors, snapshot,
    setReady(value) { ready = value; },
    async boot() {
      const clock = deliveryClock();
      const app = await startVoiceApp({
        rawOptions: { clients: ["default"], inbox_clients: ["default"], api_token: "synthetic-api-token" },
        dataRoot: directory,
        supervisorToken: "synthetic-supervisor-token",
        httpClient: transport,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        logger: { info() {}, warn() {}, error(...facts) { errors.push(facts); } },
        diagnosticsFactory: () => ({ runId: "synthetic-run", start: async () => {}, stop: async () => {} }),
        replayHealthDiagnosticsFn: async () => ({ records: [] }),
        readRecoveryRecordFn: async () => null,
        recordingStore: { start: async () => {}, close() {} },
        listenFn: async () => ({ close(done) { done(); } }),
        startAddonFn: (options) => startAddon({
          ...options,
          clientFactory: () => Object.assign(new EventEmitter(), { disconnect: async () => {} }),
        }),
      });
      apps.push(app);
      return { app, clock };
    },
    async receive(app, payload) {
      app.clients.default.emit("msg", payload);
      await waitFor(async () => (await snapshot()).pending.some((entry) => entry.payload.key.id === payload.key.id));
    },
  };
}

test("the live app delivers ordinary inbox messages while Home Assistant is running", async (t) => {
  const f = await fixture(t);
  const { app, clock } = await f.boot();
  await clock.next();
  const original = message("live-message");
  await f.receive(app, original);
  assert.equal(await clock.next(), 0);
  assert.equal(f.accepted.length, 1);
  assert.deepEqual(f.accepted[0].message, { ...original, clientId: "default" });
  assert.deepEqual(f.requests.filter((request) => request.url === "/core/api/whatsapp/inbox")
    .map((request) => request.method), ["GET", "POST"]);
  for (const request of f.requests.filter((item) => item.url === "/core/api/whatsapp/inbox")) {
    assert.equal(request.headers.authorization, "Bearer synthetic-supervisor-token");
  }
  const saved = await f.snapshot();
  assert.equal(saved.pending.length, 0);
  assert.equal(saved.delivered[0].id, f.accepted[0].id);
  await clock.next();
  assert.equal(clock.pending.length, 0);
  assert.deepEqual(f.errors, []);
});

test("the live app replays its inbox after Home Assistant finishes restarting", async (t) => {
  const f = await fixture(t);
  const { app, clock } = await f.boot();
  await clock.next();
  f.setReady(false);
  const original = message("received-during-ha-restart");
  await f.receive(app, original);
  await clock.next();
  assert.equal(f.accepted.length, 0);
  assert.equal((await f.snapshot()).pending.length, 1);
  assert.deepEqual(clock.pending.map((timer) => timer.delay), [10000]);
  assert.deepEqual(f.requests.filter((request) => request.url === "/core/api/whatsapp/inbox")
    .map((request) => request.method), ["GET"]);
  f.setReady(true);
  assert.equal(await clock.next(), 10000);
  assert.deepEqual(f.accepted.map((entry) => entry.message), [{ ...original, clientId: "default" }]);
  assert.equal((await f.snapshot()).pending.length, 0);
  await clock.next();
  assert.equal(clock.pending.length, 0);
  assert.deepEqual(f.errors, []);
});

test("the live app restores a persisted inbox after an app restart and replays it once in order", async (t) => {
  const f = await fixture(t);
  f.setReady(false);
  const first = await f.boot();
  await first.clock.next();
  const originals = [message("first-persisted-message"), message("second-persisted-message")];
  for (const original of originals) await f.receive(first.app, original);
  await first.clock.next();
  assert.equal((await f.snapshot()).pending.length, 2);
  assert.equal(f.accepted.length, 0);
  await first.app.close();
  assert.equal(first.clock.pending.length, 0);
  const restarted = await f.boot();
  assert.deepEqual((await f.snapshot()).pending.map((entry) => entry.payload), originals);
  await restarted.clock.next();
  assert.equal(f.accepted.length, 0);
  f.setReady(true);
  assert.equal(await restarted.clock.next(), 10000);
  assert.equal(await restarted.clock.next(), 0);
  await restarted.clock.next();
  assert.deepEqual(f.accepted.map((entry) => entry.message), originals.map((original) => ({ ...original, clientId: "default" })));
  const saved = await f.snapshot();
  assert.equal(saved.pending.length, 0);
  assert.equal(saved.delivered.length, 2);
  await restarted.app.close();
  const final = await f.boot();
  await final.clock.next();
  assert.equal(final.clock.pending.length, 0);
  assert.equal(f.accepted.length, 2);
  assert.deepEqual(f.errors, []);
});
