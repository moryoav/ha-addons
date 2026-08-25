const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const {
  createAddonRuntime,
  fingerprint,
  normalizeApiToken,
  normalizeCallUpdate,
  normalizeLogLevel,
  parseOptions,
  removeSessionDirectory,
  startAddon,
} = require("../runtime");
const { RequestValidationError } = require("../validation");

const FICTIONAL_NUMBER = "12025550123";
const FICTIONAL_JID = `${FICTIONAL_NUMBER}@s.whatsapp.net`;
const FICTIONAL_LID = "999999999999999@lid";

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

test("call updates normalize to one stable Home Assistant payload", () => {
  assert.deepEqual(
    normalizeCallUpdate({
      id: "fictional-call-id",
      status: "offer",
      from: FICTIONAL_LID,
      chatId: FICTIONAL_LID,
      isVideo: true,
      isGroup: false,
      date: new Date("2026-08-25T12:00:00Z"),
      offline: false,
    }),
    {
      callId: "fictional-call-id",
      status: "offer",
      from: FICTIONAL_LID,
      chatId: FICTIONAL_LID,
      isVideo: true,
      isGroup: false,
      groupJid: null,
      date: "2026-08-25T12:00:00.000Z",
      offline: false,
    }
  );
  assert.deepEqual(normalizeCallUpdate({ status: "terminate" }), {
    callId: null,
    status: "terminate",
    from: null,
    chatId: null,
    isVideo: null,
    isGroup: null,
    groupJid: null,
    date: null,
    offline: null,
  });
  assert.equal(normalizeCallUpdate({ status: "unknown" }), undefined);
  assert.equal(normalizeCallUpdate(null), undefined);
});

test("call lifecycle updates fire filterable privacy-safe events", async () => {
  const requests = [];
  const logs = [];
  const recordedStatuses = [];
  const deliveryResults = [];
  let ignored = 0;
  const client = new FakeClient();
  createAddonRuntime({
    clientIds: ["default"],
    dataRoot: path.resolve("runtime-test-data"),
    clientFactory: () => client,
    fingerprintKey: Buffer.alloc(32, 5),
    logLevel: "debug",
    runId: "0123456789abcdef",
    httpClient: {
      async post(...args) {
        requests.push(args);
      },
    },
    diagnostics: {
      recordCallDelivered: (delivered) => deliveryResults.push(delivered),
      recordCallIgnored: () => {
        ignored += 1;
      },
      recordCallUpdate: (status) => recordedStatuses.push(status),
    },
    logger: {
      debug: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
    },
  });

  const statuses = [
    "offer",
    "ringing",
    "accept",
    "reject",
    "timeout",
    "terminate",
  ];
  for (const status of statuses) {
    client.emit("call_update", {
      id: `fictional-call-${FICTIONAL_NUMBER}`,
      status,
      from: FICTIONAL_LID,
      chatId: FICTIONAL_LID,
      isVideo: false,
      isGroup: false,
      date: new Date("2026-08-25T12:00:00Z"),
      offline: false,
    });
  }
  client.emit("call_update", {
    id: `private-call-${FICTIONAL_NUMBER}`,
    status: "private-status",
    from: FICTIONAL_JID,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, statuses.length);
  assert.deepEqual(recordedStatuses, statuses);
  assert.deepEqual(deliveryResults, statuses.map(() => true));
  assert.equal(ignored, 1);
  for (const [index, request] of requests.entries()) {
    assert.equal(
      request[0],
      "http://supervisor/core/api/events/whatsapp_call_update"
    );
    assert.deepEqual(request[1], {
      clientId: "default",
      callId: `fictional-call-${FICTIONAL_NUMBER}`,
      status: statuses[index],
      from: FICTIONAL_LID,
      chatId: FICTIONAL_LID,
      isVideo: false,
      isGroup: false,
      groupJid: null,
      date: "2026-08-25T12:00:00.000Z",
      offline: false,
    });
  }
  const serializedLogs = JSON.stringify(logs);
  assert.ok(serializedLogs.includes("hmac:"));
  assert.ok(!serializedLogs.includes(FICTIONAL_NUMBER));
  assert.ok(!serializedLogs.includes(FICTIONAL_LID));
  assert.ok(!serializedLogs.includes("private-status"));
});

test("call updates retry transient Core outages and preserve event order", async () => {
  const requests = [];
  const retryDelays = [];
  const logs = [];
  const deliveryResults = [];
  let offerAttempts = 0;
  const client = new FakeClient();

  createAddonRuntime({
    clientIds: ["default"],
    dataRoot: path.resolve("runtime-test-data"),
    clientFactory: () => client,
    fingerprintKey: Buffer.alloc(32, 6),
    runId: "0123456789abcdef",
    httpClient: {
      async post(url, payload, config) {
        requests.push({ url, payload, config });
        if (payload.status === "offer" && offerAttempts < 2) {
          offerAttempts += 1;
          const error = new Error("synthetic transient failure");
          error.response = { status: 502 };
          throw error;
        }
      },
    },
    diagnostics: {
      recordCallDelivered: (delivered) => deliveryResults.push(delivered),
    },
    logger: {
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
    },
    setTimeoutFn: (callback, delayMs) => {
      retryDelays.push(delayMs);
      const timer = { delayMs };
      queueMicrotask(callback);
      return timer;
    },
    clearTimeoutFn: () => {},
  });

  client.emit("call_update", {
    id: `fictional-call-${FICTIONAL_NUMBER}`,
    status: "offer",
    from: FICTIONAL_LID,
  });
  client.emit("call_update", {
    id: `fictional-call-${FICTIONAL_NUMBER}`,
    status: "ringing",
    from: FICTIONAL_LID,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    requests.map(({ payload }) => payload.status),
    ["offer", "offer", "offer", "ringing"]
  );
  assert.deepEqual(retryDelays, [1_000, 2_000]);
  assert.deepEqual(deliveryResults, [true, true]);
  assert.ok(
    requests.every(
      ({ config }) => config.timeout === 10_000 && config.headers.Authorization
    )
  );

  const retryLogs = logs.filter(
    ([message]) =>
      message ===
      "Home Assistant call event delivery temporarily failed; retry scheduled."
  );
  assert.equal(retryLogs.length, 2);
  assert.deepEqual(
    retryLogs.map(([, details]) => ({
      callStatus: details.callStatus,
      httpStatus: details.httpStatus,
      attempt: details.attempt,
      retryInMs: details.retryInMs,
    })),
    [
      {
        callStatus: "offer",
        httpStatus: 502,
        attempt: 1,
        retryInMs: 1_000,
      },
      {
        callStatus: "offer",
        httpStatus: 502,
        attempt: 2,
        retryInMs: 2_000,
      },
    ]
  );
  assert.ok(
    logs.some(
      ([message, details]) =>
        message === "WhatsApp call update event delivered." &&
        details.callStatus === "offer" &&
        details.attempt === 3
    )
  );

  const serializedLogs = JSON.stringify(logs);
  assert.ok(serializedLogs.includes("hmac:"));
  assert.ok(!serializedLogs.includes(FICTIONAL_NUMBER));
  assert.ok(!serializedLogs.includes(FICTIONAL_LID));
});

test("call updates do not retry non-transient delivery failures", async () => {
  const requests = [];
  const deliveryResults = [];
  const logs = [];
  const client = new FakeClient();

  createAddonRuntime({
    clientIds: ["default"],
    dataRoot: path.resolve("runtime-test-data"),
    clientFactory: () => client,
    fingerprintKey: Buffer.alloc(32, 7),
    runId: "0123456789abcdef",
    httpClient: {
      async post(url, payload) {
        requests.push({ url, payload });
        if (payload.status === "reject") {
          const error = new Error("synthetic permanent failure");
          error.response = { status: 400 };
          throw error;
        }
      },
    },
    diagnostics: {
      recordCallDelivered: (delivered) => deliveryResults.push(delivered),
    },
    logger: {
      warn: (...args) => logs.push(args),
    },
  });

  client.emit("call_update", { status: "reject" });
  client.emit("call_update", { status: "terminate" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    requests.map(({ payload }) => payload.status),
    ["reject", "terminate"]
  );
  assert.deepEqual(deliveryResults, [false, true]);
  assert.ok(
    logs.some(
      ([message, details]) =>
        message === "Home Assistant call event delivery failed." &&
        details.callStatus === "reject" &&
        details.httpStatus === 400 &&
        details.attempt === 1
    )
  );
});

test("stopping the runtime cancels pending call delivery retries", async () => {
  const deliveryResults = [];
  const timers = [];
  const clearedTimers = [];
  let requests = 0;
  const client = new FakeClient();
  const runtime = createAddonRuntime({
    clientIds: ["default"],
    dataRoot: path.resolve("runtime-test-data"),
    clientFactory: () => client,
    runId: "0123456789abcdef",
    httpClient: {
      async post() {
        requests += 1;
        const error = new Error("synthetic transient failure");
        error.response = { status: 502 };
        throw error;
      },
    },
    diagnostics: {
      recordCallDelivered: (delivered) => deliveryResults.push(delivered),
    },
    logger: {},
    setTimeoutFn: (callback, delayMs) => {
      const timer = { callback, delayMs };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => clearedTimers.push(timer),
  });

  client.emit("call_update", { status: "offer" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);

  await runtime.stopCallDelivery();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests, 1);
  assert.deepEqual(clearedTimers, timers);
  assert.deepEqual(deliveryResults, [false]);
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

test("terminal health replay emits an event and a debug-only notification", async () => {
  const requests = [];
  const diagnostics = {
    runId: "0123456789abcdef",
    async start() {},
    async stop() {},
    markApiReady() {},
    setClientStateProvider() {},
  };
  const runtime = await startAddon({
    logger: {},
    optionsLoader: async () => ({
      clientIds: ["default"],
      apiToken: undefined,
      logLevel: "debug",
    }),
    diagnosticsFactory: () => diagnostics,
    replayHealthDiagnosticsFn: async () => ({
      records: [
        {
          type: "failure",
          observedAt: "2026-08-21T12:00:00Z",
          classification: "response_timeout",
          curlExit: 28,
          httpCode: 0,
          connectMs: 2,
          firstByteMs: 0,
          totalMs: 5001,
          streak: 3,
          heartbeat_age_ms: 6300,
          event_loop_lag_max_ms: 6100,
          container_memory_pct: 25,
          oom_events: 0,
        },
      ],
    }),
    clientFactory: () => new FakeClient(),
    httpClient: {
      async post(...args) {
        requests.push(args);
      },
    },
    dataRoot: path.resolve("runtime-test-data"),
    listenFn: async () => ({}),
    closeServerFn: async () => {},
  });

  const eventRequest = requests.find(([url]) =>
    url.endsWith("/core/api/events/whatsapp_addon_health_failure")
  );
  const notificationRequest = requests.find(([url]) =>
    url.endsWith("/core/api/services/persistent_notification/create")
  );
  assert.ok(eventRequest);
  assert.equal(eventRequest[1].run_id, diagnostics.runId);
  assert.equal(eventRequest[1].streak, 3);
  assert.ok(notificationRequest);
  assert.equal(
    notificationRequest[1].notification_id,
    "whatsapp_addon_health_failure"
  );
  assert.match(notificationRequest[1].message, /response_timeout/);
  assert.deepEqual(runtime.healthFailureReport, eventRequest[1]);
  await runtime.close();
});

test("info mode emits the health event without a visible notification", async () => {
  const requests = [];
  const runtime = createAddonRuntime({
    clientIds: ["default"],
    dataRoot: path.resolve("runtime-test-data"),
    clientFactory: () => new FakeClient(),
    logLevel: "info",
    httpClient: {
      async post(...args) {
        requests.push(args);
      },
    },
    logger: {},
  });
  const report = {
    schema: 1,
    service: "ha-whatsapp-addon",
    run_id: "0123456789abcdef",
    failure_count: 3,
    first_failure_at: "2026-08-21T12:00:00Z",
    last_failure_at: "2026-08-21T12:01:00Z",
    classification: "response_timeout",
    curl_exit: 28,
    http_code: 0,
    connect_ms: 2,
    first_byte_ms: 0,
    total_ms: 5001,
    streak: 3,
  };

  const delivered = await runtime.reportHealthFailure(report);
  assert.deepEqual(delivered, {
    eventDelivered: true,
    notificationDelivered: false,
  });
  assert.equal(requests.length, 1);
  assert.ok(
    requests[0][0].endsWith(
      "/core/api/events/whatsapp_addon_health_failure"
    )
  );
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
