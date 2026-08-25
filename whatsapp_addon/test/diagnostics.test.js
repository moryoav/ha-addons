const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createHealthFailureReport,
  createRuntimeDiagnostics,
  formatHealthFailureNotification,
  readCgroupSnapshot,
  replayHealthcheckDiagnostics,
  sanitizeHealthRecord,
} = require("../diagnostics");

const RUN_ID = "0123456789abcdef";

const failureRecord = (overrides = {}) => ({
  schema: 1,
  type: "failure",
  timestamp: "2026-08-21T12:00:00Z",
  classification: "response_timeout",
  curl_exit: 28,
  http_code: 0,
  time_connect_ms: 2,
  time_starttransfer_ms: 0,
  time_total_ms: 5001,
  streak: 3,
  heartbeat_age_ms: 6300,
  event_loop_lag_max_ms: 6100,
  container_memory_pct: 25,
  cpu_throttled_ms: 3,
  oom_events: 0,
  ...overrides,
});

test("health records accept only the bounded diagnostic contract", () => {
  assert.deepEqual(sanitizeHealthRecord(failureRecord()), {
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
    cpu_throttled_ms: 3,
    oom_events: 0,
  });

  for (const record of [
    failureRecord({ classification: "private-text" }),
    failureRecord({ curl_exit: "28" }),
    failureRecord({ time_total_ms: -1 }),
    failureRecord({ timestamp: "not-a-date" }),
    { ...failureRecord(), schema: 2 },
  ]) {
    assert.equal(sanitizeHealthRecord(record), undefined);
  }
});

test("pending health failures are safely replayed and archived once", async (t) => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "ha-whatsapp-diagnostics-")
  );
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const pendingPath = path.join(directory, "health.pending");
  const privateText = "private phone 12025550123 and message contents";
  const recovery = {
    schema: 1,
    type: "recovery",
    timestamp: "2026-08-21T12:01:00Z",
    prior_streak: 3,
    time_total_ms: 4,
    heartbeat_age_ms: 10,
    ignored_private_field: privateText,
  };
  await fs.promises.writeFile(
    pendingPath,
    [
      JSON.stringify({ ...failureRecord(), ignored_private_field: privateText }),
      JSON.stringify(recovery),
      JSON.stringify(failureRecord({ classification: privateText })),
    ].join("\n")
  );

  const logs = [];
  const logger = { warn: (...args) => logs.push(args) };
  const result = await replayHealthcheckDiagnostics({
    logger,
    runId: RUN_ID,
    failurePath: pendingPath,
  });

  assert.equal(result.replayed, 2);
  assert.equal(result.invalid, 1);
  assert.equal(result.records.length, 2);
  assert.equal(fs.existsSync(pendingPath), false);
  assert.equal(fs.existsSync(`${pendingPath}.reported`), true);
  assert.equal(JSON.stringify(logs).includes(privateText), false);
  assert.equal(JSON.stringify(result.records).includes(privateText), false);
  assert.equal(JSON.stringify(logs).includes("response_timeout"), true);

  const second = await replayHealthcheckDiagnostics({
    logger,
    runId: RUN_ID,
    failurePath: pendingPath,
  });
  assert.equal(second.replayed, 0);
  assert.deepEqual(second.records, []);
});

test("terminal unhealthy streak creates one bounded Home Assistant report", () => {
  const recovery = sanitizeHealthRecord({
    schema: 1,
    type: "recovery",
    timestamp: "2026-08-21T11:59:00Z",
    prior_streak: 1,
    time_total_ms: 4,
  });
  const records = [
    sanitizeHealthRecord(
      failureRecord({ timestamp: "2026-08-21T11:58:30Z", streak: 1 })
    ),
    recovery,
    sanitizeHealthRecord(
      failureRecord({ timestamp: "2026-08-21T12:00:00Z", streak: 1 })
    ),
    sanitizeHealthRecord(
      failureRecord({ timestamp: "2026-08-21T12:00:30Z", streak: 2 })
    ),
    sanitizeHealthRecord(
      failureRecord({ timestamp: "2026-08-21T12:01:00Z", streak: 3 })
    ),
  ];

  const report = createHealthFailureReport(records, { runId: RUN_ID });
  assert.deepEqual(report, {
    schema: 1,
    service: "ha-whatsapp-addon",
    run_id: RUN_ID,
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
    heartbeat_age_ms: 6300,
    event_loop_lag_max_ms: 6100,
    container_memory_pct: 25,
    cpu_throttled_ms: 3,
    oom_events: 0,
  });

  const message = formatHealthFailureNotification(report);
  assert.match(
    message,
    /2026-08-21T12:00:00Z to 2026-08-21T12:01:00Z/
  );
  assert.match(message, /response_timeout/);
  assert.match(message, /final streak: 3/);
  assert.match(message, /whatsapp_addon_health_failure/);
  assert.equal(message.includes("undefined"), false);
});

test("transient or recovered health failures do not create a report", () => {
  const oneFailure = sanitizeHealthRecord(failureRecord({ streak: 1 }));
  const unhealthyFailure = sanitizeHealthRecord(failureRecord({ streak: 3 }));
  const recovery = sanitizeHealthRecord({
    schema: 1,
    type: "recovery",
    timestamp: "2026-08-21T12:01:00Z",
    prior_streak: 3,
    time_total_ms: 4,
  });

  assert.equal(
    createHealthFailureReport([oneFailure], { runId: RUN_ID }),
    undefined
  );
  assert.equal(
    createHealthFailureReport([unhealthyFailure, recovery], { runId: RUN_ID }),
    undefined
  );
});

test("runtime diagnostics emit bounded summaries and rate-limited warnings", async () => {
  let timestamp = 1_000;
  let intervalCallback;
  let metrics = {
    cpuPct: 4,
    containerCpuPct: 5,
    containerMemoryLimitMb: 512,
    containerMemoryMb: 128,
    containerMemoryPct: 25,
    cpuThrottledMs: 0,
    eventLoopLagMaxMs: 10,
    eventLoopLagP99Ms: 2,
    eventLoopUtilizationPct: 3,
    heapUsedMb: 30,
    oomEvents: 0,
    rssMb: 60,
  };
  const writes = [];
  const logs = { debug: [], info: [], warn: [] };
  const logger = Object.fromEntries(
    Object.keys(logs).map((level) => [
      level,
      (...args) => logs[level].push(args),
    ])
  );
  const diagnostics = createRuntimeDiagnostics({
    logger,
    logLevel: "debug",
    runId: RUN_ID,
    heartbeatPath: "/fictional/runtime-heartbeat.json",
    now: () => timestamp,
    metricsSampler: {
      sample: () => metrics,
      start() {},
      stop() {},
    },
    fsPromises: {
      async writeFile(filePath, content) {
        writes.push({ content, filePath });
      },
      async rename() {},
      async unlink() {},
    },
    setIntervalFn(callback) {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
    missingProbeMs: 50_000,
    summaryIntervalMs: 60_000,
    warningCooldownMs: 300_000,
  });

  await diagnostics.start();
  diagnostics.markApiReady();
  for (const status of [
    "offer",
    "ringing",
    "accept",
    "reject",
    "timeout",
    "terminate",
  ]) {
    diagnostics.recordCallUpdate(status);
  }
  diagnostics.recordCallDelivered(true);
  diagnostics.recordCallDelivered(false);
  diagnostics.recordCallIgnored();
  diagnostics.recordMessageBatch(12);
  diagnostics.recordMessageIgnored("from_me");
  diagnostics.recordMessageDuplicate();
  diagnostics.recordConnection("reconnect_scheduled");
  const completeApi = diagnostics.startApiRequest();
  timestamp += 2_500;
  completeApi();

  timestamp = 61_000;
  metrics = {
    ...metrics,
    eventLoopLagMaxMs: 2_500,
    eventLoopLagP99Ms: 2_100,
  };
  await diagnostics.tick();
  await diagnostics.tick();

  assert.equal(typeof intervalCallback, "function");
  assert.equal(logs.debug.length, 1);
  const summary = JSON.parse(logs.debug[0][1]);
  assert.equal(summary.activity.callUpdatesReceived, 6);
  assert.equal(summary.activity.callOffers, 1);
  assert.equal(summary.activity.callRinging, 1);
  assert.equal(summary.activity.callAccepted, 1);
  assert.equal(summary.activity.callRejected, 1);
  assert.equal(summary.activity.callTimedOut, 1);
  assert.equal(summary.activity.callTerminated, 1);
  assert.equal(summary.activity.callUpdatesDelivered, 1);
  assert.equal(summary.activity.callUpdateDeliveryFailed, 1);
  assert.equal(summary.activity.callUpdatesIgnored, 1);
  assert.equal(summary.activity.messagesReceived, 12);
  assert.equal(summary.activity.messageIgnoredFromMe, 1);
  assert.equal(summary.activity.apiSlow, 1);
  assert.equal(logs.warn.filter(([message]) => message.includes("lag")).length, 1);
  assert.equal(logs.warn.filter(([message]) => message.includes("missing")).length, 1);

  diagnostics.recordNativeHealthProbe();
  assert.equal(logs.info.length, 1);
  assert.equal(logs.info[0][0], "Native container health requests resumed.");
  assert.ok(writes.length >= 2);
  const heartbeat = JSON.parse(writes.at(-1).content);
  assert.equal(heartbeat.run_id, RUN_ID);
  assert.equal(heartbeat.event_loop_lag_max_ms, 2500);
  assert.equal(heartbeat.container_memory_pct, 25);
  assert.ok(!JSON.stringify(logs).includes("12025550123"));
  await diagnostics.stop();
});

test("cgroup reader exposes only fixed numeric resource fields", () => {
  const files = new Map([
    ["/sys/fs/cgroup/cpu.stat", "usage_usec 4000\nthrottled_usec 1200\n"],
    ["/sys/fs/cgroup/memory.events", "oom 2\noom_kill 1\n"],
    ["/sys/fs/cgroup/memory.current", "1048576\n"],
    ["/sys/fs/cgroup/memory.max", "4194304\n"],
  ]);
  const result = readCgroupSnapshot((filePath) => {
    if (!files.has(filePath)) throw new Error("missing fictional file");
    return files.get(filePath);
  });

  assert.deepEqual(result, {
    cpuUsageUsec: 4000,
    memoryBytes: 1048576,
    memoryLimitBytes: 4194304,
    oomEvents: 3,
    throttledUsec: 1200,
  });
});
