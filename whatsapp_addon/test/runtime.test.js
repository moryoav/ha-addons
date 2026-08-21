const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const {
  createAddonRuntime,
  fingerprint,
  normalizeApiToken,
  normalizeLogLevel,
  parseOptions,
  removeSessionDirectory,
  startAddon,
} = require("../runtime");
const { RequestValidationError } = require("../validation");

const FICTIONAL_NUMBER = "12025550123";
const FICTIONAL_JID = `${FICTIONAL_NUMBER}@s.whatsapp.net`;

class FakeClient extends EventEmitter {
  async disconnect() {}
}

test("options parsing validates client IDs and optional bearer tokens", () => {
  assert.deepEqual(
    parseOptions(
      JSON.stringify({
        clients: ["default", "backup_1"],
        api_token: "fictional-token_123456",
      })
    ),
    {
      clientIds: ["default", "backup_1"],
      apiToken: "fictional-token_123456",
      logLevel: "info",
    }
  );
  assert.equal(normalizeApiToken(""), undefined);
  assert.equal(normalizeApiToken(undefined), undefined);
  assert.equal(normalizeLogLevel(undefined), "info");
  assert.equal(normalizeLogLevel("debug"), "debug");
  for (const value of ["trace", "", null]) {
    assert.throws(() => normalizeLogLevel(value), RequestValidationError);
  }

  for (const token of ["has spaces", "line\nbreak", "bad:token", "a".repeat(513)]) {
    assert.throws(() => normalizeApiToken(token), RequestValidationError);
  }
  for (const content of [
    "not-json",
    JSON.stringify({ clients: [] }),
    JSON.stringify({ clients: ["../escape"] }),
    JSON.stringify({ clients: ["default", "default"] }),
  ]) {
    assert.throws(() => parseOptions(content), RequestValidationError);
  }
});

test("debug diagnostics are configured before clients are created", async () => {
  const calls = [];
  const logger = {
    level: "info",
    debug: (...args) => calls.push(["debug", ...args]),
    info: (...args) => calls.push(["info", ...args]),
  };
  const diagnostics = {
    runId: "0123456789abcdef",
    async start() {
      calls.push(["diagnostics_start", logger.level]);
    },
    async stop() {},
    markApiReady() {},
    setClientStateProvider() {},
  };
  const servers = [];

  const runtime = await startAddon({
    logger,
    optionsLoader: async () => ({
      clientIds: ["default"],
      apiToken: undefined,
      logLevel: "debug",
    }),
    diagnosticsFactory: () => diagnostics,
    replayHealthDiagnosticsFn: async () => {},
    clientFactory: () => {
      calls.push(["client_created", logger.level]);
      return new FakeClient();
    },
    httpClient: { post: async () => {} },
    dataRoot: path.resolve("runtime-test-data"),
    listenFn: async () => {
      const server = {};
      servers.push(server);
      return server;
    },
    closeServerFn: async () => {},
  });

  assert.equal(logger.level, "debug");
  assert.deepEqual(
    calls.filter(([event]) =>
      ["diagnostics_start", "client_created"].includes(event)
    ),
    [
      ["diagnostics_start", "debug"],
      ["client_created", "debug"],
    ]
  );
  const startup = calls.find(
    ([level, message]) =>
      level === "info" && message === "WhatsApp add-on runtime starting."
  );
  assert.equal(startup[2].runId, diagnostics.runId);
  assert.equal(startup[2].logLevel, "debug");
  assert.equal(servers.length, 2);
  await runtime.close();
});

test("session deletion awaits one validated child path", async () => {
  const calls = [];
  const dataRoot = path.resolve("runtime-test-data");
  const fsPromises = {
    async rm(...args) {
      calls.push(args);
    },
  };

  await removeSessionDirectory({ dataRoot, clientId: "default", fsPromises });
  assert.deepEqual(calls, [
    [path.join(dataRoot, "default"), { recursive: true, force: true }],
  ]);

  await assert.rejects(
    () =>
      removeSessionDirectory({
        dataRoot,
        clientId: "../outside",
        fsPromises,
      }),
    RequestValidationError
  );
  assert.equal(calls.length, 1);
});

test("logout waits for deletion before creating a replacement client", async () => {
  let finishRemoval;
  const removals = [];
  const clientsCreated = [];
  const dataRoot = path.resolve("runtime-test-data");
  const fsPromises = {
    rm(sessionPath, options) {
      removals.push({ options, sessionPath });
      return new Promise((resolve) => {
        finishRemoval = resolve;
      });
    },
  };
  const runtime = createAddonRuntime({
    clientIds: ["default"],
    dataRoot,
    fsPromises,
    clientFactory: ({ path: sessionPath }) => {
      const client = new FakeClient();
      clientsCreated.push({ client, sessionPath });
      return client;
    },
    logger: {},
  });

  clientsCreated[0].client.emit("logout");
  await Promise.resolve();
  assert.equal(Object.hasOwn(runtime.clients, "default"), false);
  assert.equal(clientsCreated.length, 1);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].sessionPath, path.join(dataRoot, "default"));

  finishRemoval();
  await runtime.logoutTasks.get("default");
  assert.equal(clientsCreated.length, 2);
  assert.equal(runtime.clients.default, clientsCreated[1].client);
});

test("log references use keyed per-process pseudonyms", () => {
  const firstKey = Buffer.alloc(32, 1);
  const secondKey = Buffer.alloc(32, 2);
  const first = fingerprint(FICTIONAL_JID, firstKey);

  assert.equal(first, fingerprint(FICTIONAL_JID, firstKey));
  assert.notEqual(first, fingerprint(FICTIONAL_JID, secondKey));
  assert.match(first, /^hmac:[a-f0-9]{12}$/);
  assert.ok(!first.includes(FICTIONAL_NUMBER));
});

test("runtime logs contain neither raw identifiers nor raw errors", () => {
  const entries = [];
  const logger = {
    debug: (...args) => entries.push(args),
    error: (...args) => entries.push(args),
    info: (...args) => entries.push(args),
    warn: (...args) => entries.push(args),
  };
  const client = new FakeClient();
  createAddonRuntime({
    clientIds: ["default"],
    dataRoot: path.resolve("runtime-test-data"),
    clientFactory: () => client,
    fingerprintKey: Buffer.alloc(32, 3),
    logger,
  });

  client.emit("msg_duplicate", {
    keyId: `message-${FICTIONAL_NUMBER}`,
    type: "conversation",
    firstRemoteJid: FICTIONAL_JID,
    duplicateRemoteJid: FICTIONAL_JID,
    firstSeenAt: 1,
    duplicateSeenAt: 2,
    ageMs: 1,
  });
  const error = new Error(`raw failure ${FICTIONAL_JID}`);
  error.upstreamCode = "arbitrary-private-code";
  client.emit("client_error", error);

  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes(FICTIONAL_NUMBER));
  assert.ok(!serialized.includes("raw failure"));
  assert.ok(!serialized.includes("arbitrary-private-code"));
  assert.ok(serialized.includes("hmac:"));
});

test("debug message detail is capped and privacy-sanitized", () => {
  const entries = [];
  const counters = [];
  const logger = { debug: (...args) => entries.push(args) };
  const client = new FakeClient();
  createAddonRuntime({
    clientIds: ["default"],
    dataRoot: path.resolve("runtime-test-data"),
    clientFactory: () => client,
    fingerprintKey: Buffer.alloc(32, 4),
    logLevel: "debug",
    runId: "0123456789abcdef",
    diagnostics: {
      recordMessageBatch: (...args) => counters.push(args),
    },
    logger,
  });

  const messages = Array.from({ length: 12 }, (_, index) => ({
    hasMessage: true,
    fromMe: false,
    type: index === 0 ? `private-${FICTIONAL_NUMBER}` : "conversation",
    messageId: `message-${FICTIONAL_NUMBER}-${index}`,
    remoteJid: FICTIONAL_JID,
    participant: FICTIONAL_JID,
  }));
  client.emit("msg_upsert", {
    count: 12,
    type: `private-${FICTIONAL_NUMBER}`,
    requestId: `request-${FICTIONAL_NUMBER}`,
    messages,
  });

  assert.deepEqual(counters, [[12]]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1].messages.length, 10);
  assert.equal(entries[0][1].omitted, 2);
  assert.equal(entries[0][1].type, "other");
  assert.equal(entries[0][1].messages[0].type, "other");
  assert.equal(JSON.stringify(entries).includes(FICTIONAL_NUMBER), false);
});

test("discovery advertises the optional token without logging it", async () => {
  const requests = [];
  const logs = [];
  const runtime = createAddonRuntime({
    clientIds: ["default"],
    apiToken: "fictional-token_123456",
    dataRoot: path.resolve("runtime-test-data"),
    clientFactory: () => new FakeClient(),
    hostname: "fictional-addon-host",
    httpClient: {
      async post(...args) {
        requests.push(args);
      },
    },
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
  });

  await runtime.registerDiscovery();
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], "http://supervisor/discovery");
  assert.deepEqual(requests[0][1], {
    service: "whatsapp",
    config: {
      url: "http://fictional-addon-host:3000",
      host: "fictional-addon-host",
      port: 3000,
      api_token: "fictional-token_123456",
    },
  });
  assert.ok(!JSON.stringify(logs).includes("fictional-token_123456"));
});

test("partial startup closes the API listener and clients if ingress fails", async () => {
  const apiServer = { name: "api-server" };
  const closed = [];
  let disconnects = 0;
  let listenCalls = 0;

  await assert.rejects(
    () =>
      startAddon({
        optionsLoader: async () => ({
          clientIds: ["default"],
          apiToken: undefined,
        }),
        clientFactory: () => {
          const client = new FakeClient();
          client.disconnect = async () => {
            disconnects += 1;
          };
          return client;
        },
        dataRoot: path.resolve("runtime-test-data"),
        listenFn: async () => {
          listenCalls += 1;
          if (listenCalls === 1) return apiServer;
          throw new Error("fictional ingress bind failure");
        },
        closeServerFn: async (server) => closed.push(server),
        logger: {},
      }),
    /fictional ingress bind failure/
  );

  assert.equal(disconnects, 1);
  assert.deepEqual(closed, [apiServer]);
});
