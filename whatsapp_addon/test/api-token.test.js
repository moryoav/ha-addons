const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { API_TOKEN_FILE, loadOrCreateApiToken } = require("../api-token");
const { startAddon } = require("../runtime");

const directory = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-api-token-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

test("first startup creates a private token and later starts retain it", async (t) => {
  const dataRoot = await directory(t);
  const first = await loadOrCreateApiToken({ dataRoot });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await loadOrCreateApiToken({ dataRoot }), first);
  assert.equal(await loadOrCreateApiToken({ dataRoot, legacyToken: "different-legacy-token" }), first);
  assert.deepEqual(await fs.readdir(dataRoot), [API_TOKEN_FILE]);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(dataRoot, API_TOKEN_FILE))).mode & 0o777, 0o600);
  }
});

test("existing user tokens are adopted once without changing their credential", async (t) => {
  const dataRoot = await directory(t);
  assert.equal(await loadOrCreateApiToken({ dataRoot, legacyToken: "fictional-existing-token" }), "fictional-existing-token");
  assert.equal(await loadOrCreateApiToken({ dataRoot }), "fictional-existing-token");
});

test("concurrent first starts all use the same complete token", async (t) => {
  const dataRoot = await directory(t);
  const values = await Promise.all(Array.from({ length: 12 }, () => loadOrCreateApiToken({ dataRoot })));
  assert.equal(new Set(values).size, 1);
  assert.match(values[0], /^[a-f0-9]{64}$/);
  assert.deepEqual(await fs.readdir(dataRoot), [API_TOKEN_FILE]);
});

test("corrupt saved credentials fail without replacement or secret disclosure", async (t) => {
  const dataRoot = await directory(t);
  for (const content of ["", "fictional invalid secret", "x".repeat(514)]) {
    await fs.writeFile(path.join(dataRoot, API_TOKEN_FILE), content);
    await assert.rejects(loadOrCreateApiToken({ dataRoot }), { message: "Could not prepare internal API authentication." });
    assert.equal(await fs.readFile(path.join(dataRoot, API_TOKEN_FILE), "utf8"), content);
  }
});

test("a credential directory is never replaced", async (t) => {
  const dataRoot = await directory(t);
  await fs.mkdir(path.join(dataRoot, API_TOKEN_FILE));
  await assert.rejects(loadOrCreateApiToken({ dataRoot }), /Could not prepare internal API authentication/);
  assert.equal((await fs.stat(path.join(dataRoot, API_TOKEN_FILE))).isDirectory(), true);
});

test("failed publication removes the temporary credential and keeps the API closed", async (t) => {
  const dataRoot = await directory(t);
  await assert.rejects(loadOrCreateApiToken({ dataRoot, fsPromises: {
    ...fs, link: async () => { throw new Error("fictional private filesystem detail"); },
  } }), { message: "Could not prepare internal API authentication." });
  assert.deepEqual(await fs.readdir(dataRoot), []);
});

test("saved credentials cannot be symlinks", { skip: process.platform === "win32" }, async (t) => {
  const dataRoot = await directory(t);
  const elsewhere = path.join(dataRoot, "fictional-secret");
  await fs.writeFile(elsewhere, "fictional-token");
  await fs.symlink(elsewhere, path.join(dataRoot, API_TOKEN_FILE));
  await assert.rejects(loadOrCreateApiToken({ dataRoot }), /Could not prepare internal API authentication/);
  assert.equal(await fs.readFile(elsewhere, "utf8"), "fictional-token");
});

test("startup shares the managed token with discovery and protected APIs without logging it", async (t) => {
  const dataRoot = await directory(t);
  const requests = [], logs = [], servers = [];
  const runtime = await startAddon({
    dataRoot, optionsLoader: async () => ({ clientIds: ["default"] }),
    logger: { info: (...args) => logs.push(args), warn() {}, error() {} },
    clientFactory: () => Object.assign(new EventEmitter(), { disconnect: async () => {} }),
    diagnosticsFactory: () => ({}), replayHealthDiagnosticsFn: async () => ({}),
    readRecoveryRecordFn: async () => undefined,
    httpClient: { post: async (...args) => requests.push(args) },
    listenFn: async (app) => {
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      servers.push(server);
      return server;
    },
  });
  t.after(() => runtime.close());
  const token = await fs.readFile(path.join(dataRoot, API_TOKEN_FILE), "utf8");
  const discovery = requests.find(([url]) => url.endsWith("/discovery"));
  assert.equal(discovery[1].config.api_token, token.trim());
  const base = `http://127.0.0.1:${servers[0].address().port}`;
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/status")).status, 401);
  assert.equal((await fetch(base + "/status", { headers: { Authorization: `Bearer ${token.trim()}` } })).status, 200);
  assert.equal(JSON.stringify(logs).includes(token.trim()), false);
});

test("authentication failure stops startup before clients or HTTP listeners exist", async () => {
  for (const apiTokenLoader of [async () => undefined, async () => { throw new Error("Authentication unavailable"); }]) {
    let created = false;
    await assert.rejects(startAddon({
      optionsLoader: async () => ({ clientIds: ["default"] }), apiTokenLoader,
      clientFactory: () => { created = true; }, listenFn: () => { created = true; },
    }));
    assert.equal(created, false);
  }
});
