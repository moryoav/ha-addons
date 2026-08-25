const crypto = require("crypto");
const fs = require("fs");
const { monitorEventLoopDelay, performance } = require("perf_hooks");

const DEFAULT_HEALTH_FAILURE_PATH = "/data/healthcheck-failures.pending";
const DEFAULT_HEARTBEAT_PATH = "/tmp/whatsapp-runtime-heartbeat.json";
const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;
const DEFAULT_SUMMARY_INTERVAL_MS = 60_000;
const DEFAULT_MISSING_PROBE_MS = 95_000;
const DEFAULT_LAG_WARNING_MS = 2_000;
const DEFAULT_WARNING_COOLDOWN_MS = 5 * 60_000;
const MAX_HEALTH_RECORDS = 50;
const MAX_HEALTH_FILE_BYTES = 128 * 1024;
const DOCKER_UNHEALTHY_STREAK = 3;
const ONE_MIB = 1024 * 1024;

const HEALTH_METRIC_BOUNDS = Object.freeze({
  heartbeat_age_ms: [0, 86_400_000],
  event_loop_lag_ms: [0, 86_400_000],
  event_loop_lag_max_ms: [0, 86_400_000],
  rss_mb: [0, 1024 * 1024],
  heap_used_mb: [0, 1024 * 1024],
  cpu_pct: [0, 100_000],
  event_loop_utilization_pct: [0, 100],
  container_cpu_pct: [0, 100_000],
  container_memory_mb: [0, 1024 * 1024],
  container_memory_limit_mb: [0, 1024 * 1024],
  container_memory_pct: [0, 100_000],
  cpu_throttled_ms: [0, 86_400_000],
  oom_events: [0, 1_000_000_000],
});

const HEALTH_FAILURE_CLASSIFICATIONS = new Set([
  "connect_timeout",
  "response_timeout",
  "transfer_timeout",
  "connection_failed",
  "dns_failed",
  "http_error",
  "empty_response",
  "connection_reset",
  "curl_unavailable",
  "curl_error",
]);

const CLIENT_STATES = new Set([
  "connected",
  "connecting",
  "disconnected",
  "logged_out",
  "pairing",
  "reconnecting",
  "restarting",
]);

const IGNORED_MESSAGE_REASONS = new Set([
  "from_me",
  "missing_message",
  "missing_message_type",
]);

const round = (value, digits = 1) => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const readCgroupNumber = (readFileSync, filePath) => {
  try {
    const value = readFileSync(filePath, "utf8").trim();
    if (value === "max" || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const readCgroupStat = (readFileSync, filePath) => {
  try {
    const result = Object.create(null);
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = /^([a-z_]+) (\d+)$/.exec(line);
      if (!match) continue;
      const value = Number(match[2]);
      if (Number.isSafeInteger(value)) result[match[1]] = value;
    }
    return result;
  } catch {
    return Object.create(null);
  }
};

const readCgroupSnapshot = (readFileSync = fs.readFileSync) => {
  const v2Cpu = readCgroupStat(readFileSync, "/sys/fs/cgroup/cpu.stat");
  const v2MemoryEvents = readCgroupStat(
    readFileSync,
    "/sys/fs/cgroup/memory.events"
  );
  const v2Usage = readCgroupNumber(
    readFileSync,
    "/sys/fs/cgroup/memory.current"
  );
  const v2Limit = readCgroupNumber(readFileSync, "/sys/fs/cgroup/memory.max");
  if (v2Usage !== undefined || v2Cpu.usage_usec !== undefined) {
    return {
      cpuUsageUsec: v2Cpu.usage_usec,
      memoryBytes: v2Usage,
      memoryLimitBytes: v2Limit,
      oomEvents: (v2MemoryEvents.oom || 0) + (v2MemoryEvents.oom_kill || 0),
      throttledUsec: v2Cpu.throttled_usec,
    };
  }

  const v1CpuUsageNs = readCgroupNumber(
    readFileSync,
    "/sys/fs/cgroup/cpuacct/cpuacct.usage"
  );
  const v1Cpu = readCgroupStat(readFileSync, "/sys/fs/cgroup/cpu/cpu.stat");
  return {
    cpuUsageUsec:
      v1CpuUsageNs === undefined ? undefined : Math.round(v1CpuUsageNs / 1000),
    memoryBytes: readCgroupNumber(
      readFileSync,
      "/sys/fs/cgroup/memory/memory.usage_in_bytes"
    ),
    memoryLimitBytes: readCgroupNumber(
      readFileSync,
      "/sys/fs/cgroup/memory/memory.limit_in_bytes"
    ),
    oomEvents: 0,
    throttledUsec:
      v1Cpu.throttled_time === undefined
        ? undefined
        : Math.round(v1Cpu.throttled_time / 1000),
  };
};

const boundedNumber = (value, minimum, maximum) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= minimum &&
  value <= maximum
    ? value
    : undefined;

const boundedInteger = (value, minimum, maximum) =>
  Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;

const isSafeTimestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

const createRunId = (randomBytes = crypto.randomBytes) =>
  randomBytes(8).toString("hex");

const normalizeRunId = (value) =>
  typeof value === "string" && /^[a-f0-9]{8,32}$/.test(value)
    ? value
    : createRunId();

const sanitizeOptionalHealthMetrics = (record) => {
  const result = {};

  for (const [key, [minimum, maximum]] of Object.entries(
    HEALTH_METRIC_BOUNDS
  )) {
    if (record[key] === undefined) continue;
    const value = boundedNumber(record[key], minimum, maximum);
    if (value === undefined) return undefined;
    result[key] = round(value);
  }

  return result;
};

const sanitizeHealthRecord = (record) => {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.schema !== 1 ||
    !isSafeTimestamp(record.timestamp)
  ) {
    return undefined;
  }

  const optionalMetrics = sanitizeOptionalHealthMetrics(record);
  if (!optionalMetrics) return undefined;

  if (record.type === "failure") {
    const curlExit = boundedInteger(record.curl_exit, 0, 255);
    const httpCode = boundedInteger(record.http_code, 0, 599);
    const connectMs = boundedNumber(record.time_connect_ms, 0, 86_400_000);
    const firstByteMs = boundedNumber(
      record.time_starttransfer_ms,
      0,
      86_400_000
    );
    const totalMs = boundedNumber(record.time_total_ms, 0, 86_400_000);
    const streak = boundedInteger(record.streak, 1, 10_000);
    if (
      !HEALTH_FAILURE_CLASSIFICATIONS.has(record.classification) ||
      curlExit === undefined ||
      httpCode === undefined ||
      connectMs === undefined ||
      firstByteMs === undefined ||
      totalMs === undefined ||
      streak === undefined
    ) {
      return undefined;
    }

    return {
      type: "failure",
      observedAt: record.timestamp,
      classification: record.classification,
      curlExit,
      httpCode,
      connectMs: round(connectMs),
      firstByteMs: round(firstByteMs),
      totalMs: round(totalMs),
      streak,
      ...optionalMetrics,
    };
  }

  if (record.type === "recovery") {
    const priorStreak = boundedInteger(record.prior_streak, 1, 10_000);
    const totalMs = boundedNumber(record.time_total_ms, 0, 86_400_000);
    if (priorStreak === undefined || totalMs === undefined) return undefined;

    return {
      type: "recovery",
      observedAt: record.timestamp,
      priorStreak,
      totalMs: round(totalMs),
      ...optionalMetrics,
    };
  }

  return undefined;
};

const replayHealthcheckDiagnostics = async ({
  logger = console,
  runId,
  failurePath =
    process.env.HA_HEALTH_FAILURE_PATH || DEFAULT_HEALTH_FAILURE_PATH,
  fsPromises = fs.promises,
} = {}) => {
  const archivePath = `${failurePath}.reported`;
  try {
    await fsPromises.rename(failurePath, archivePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { archivePath, invalid: 0, records: [], replayed: 0 };
    }
    logger.warn?.("Previous health diagnostics could not be archived.", {
      runId,
    });
    return { archivePath, invalid: 0, records: [], replayed: 0 };
  }

  let content;
  try {
    content = await fsPromises.readFile(archivePath);
  } catch {
    logger.warn?.("Archived health diagnostics could not be read.", { runId });
    return { archivePath, invalid: 0, records: [], replayed: 0 };
  }

  if (content.length > MAX_HEALTH_FILE_BYTES) {
    logger.warn?.("Archived health diagnostics exceeded the safe size limit.", {
      runId,
    });
    return { archivePath, invalid: 1, records: [], replayed: 0 };
  }

  const lines = content
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const retainedLines = lines.slice(-MAX_HEALTH_RECORDS);
  let invalid = lines.length - retainedLines.length;
  const records = [];
  let replayed = 0;

  for (const line of retainedLines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid += 1;
      continue;
    }
    const record = sanitizeHealthRecord(parsed);
    if (!record) {
      invalid += 1;
      continue;
    }

    const message =
      record.type === "failure"
        ? "Previous container health check failure recorded."
        : "Previous container health check recovery recorded.";
    logger.warn?.(message, { runId, ...record });
    records.push(record);
    replayed += 1;
  }

  if (invalid > 0) {
    logger.warn?.("Invalid previous health diagnostic records were ignored.", {
      runId,
      count: invalid,
    });
  }

  return { archivePath, invalid, records, replayed };
};

const createHealthFailureReport = (records, { runId } = {}) => {
  if (!Array.isArray(records) || records.length === 0) return undefined;

  const retained = records.slice(-MAX_HEALTH_RECORDS);
  const terminalRecord = retained.at(-1);
  if (
    terminalRecord?.type !== "failure" ||
    !Number.isInteger(terminalRecord.streak) ||
    terminalRecord.streak < DOCKER_UNHEALTHY_STREAK
  ) {
    return undefined;
  }

  let incidentStart = 0;
  for (let index = retained.length - 1; index >= 0; index -= 1) {
    if (retained[index]?.type === "recovery") {
      incidentStart = index + 1;
      break;
    }
  }

  const failures = retained
    .slice(incidentStart)
    .filter((record) => record?.type === "failure");
  if (failures.length === 0) return undefined;

  const firstFailure = failures[0];
  const lastFailure = failures.at(-1);
  const metrics = {};
  for (const key of Object.keys(HEALTH_METRIC_BOUNDS)) {
    if (lastFailure[key] !== undefined) metrics[key] = lastFailure[key];
  }

  return {
    schema: 1,
    service: "ha-whatsapp-addon",
    run_id: normalizeRunId(runId),
    failure_count: failures.length,
    first_failure_at: firstFailure.observedAt,
    last_failure_at: lastFailure.observedAt,
    classification: lastFailure.classification,
    curl_exit: lastFailure.curlExit,
    http_code: lastFailure.httpCode,
    connect_ms: lastFailure.connectMs,
    first_byte_ms: lastFailure.firstByteMs,
    total_ms: lastFailure.totalMs,
    streak: lastFailure.streak,
    ...metrics,
  };
};

const formatHealthFailureNotification = (report) => {
  if (!report) return "";

  const lines = [
    "The previous WhatsApp add-on run ended while its native health check was failing.",
    "",
    `- Incident window: ${report.first_failure_at} to ${report.last_failure_at}`,
    `- Result: ${report.classification} (curl exit ${report.curl_exit}, ${
      report.http_code === 0 ? "no HTTP response" : `HTTP ${report.http_code}`
    })`,
    `- Failed probes retained: ${report.failure_count}; final streak: ${report.streak}`,
    `- Probe timing: connect ${report.connect_ms} ms, first byte ${report.first_byte_ms} ms, total ${report.total_ms} ms`,
  ];

  if (
    report.heartbeat_age_ms !== undefined ||
    report.event_loop_lag_ms !== undefined ||
    report.event_loop_lag_max_ms !== undefined
  ) {
    lines.push(
      `- Runtime heartbeat: age ${
        report.heartbeat_age_ms ?? "unknown"
      } ms, event-loop p99 ${
        report.event_loop_lag_ms ?? "unknown"
      } ms, max ${report.event_loop_lag_max_ms ?? "unknown"} ms`
    );
  }

  if (
    report.cpu_pct !== undefined ||
    report.rss_mb !== undefined ||
    report.heap_used_mb !== undefined
  ) {
    lines.push(
      `- Node process: CPU ${report.cpu_pct ?? "unknown"}%, RSS ${
        report.rss_mb ?? "unknown"
      } MiB, heap ${report.heap_used_mb ?? "unknown"} MiB`
    );
  }

  if (
    report.container_cpu_pct !== undefined ||
    report.container_memory_mb !== undefined ||
    report.container_memory_pct !== undefined ||
    report.cpu_throttled_ms !== undefined ||
    report.oom_events !== undefined
  ) {
    lines.push(
      `- Container: CPU ${
        report.container_cpu_pct ?? "unknown"
      }%, memory ${report.container_memory_mb ?? "unknown"}/${
        report.container_memory_limit_mb ?? "unknown"
      } MiB (${report.container_memory_pct ?? "unknown"}%), throttled ${
        report.cpu_throttled_ms ?? "unknown"
      } ms, OOM events ${report.oom_events ?? "unknown"}`
    );
  }

  lines.push(
    "",
    "The sanitized records were replayed into the add-on log.",
    "Automation event: whatsapp_addon_health_failure"
  );
  return lines.join("\n");
};

const createSystemMetricsSampler = ({
  cpuUsage = process.cpuUsage.bind(process),
  memoryUsage = process.memoryUsage.bind(process),
  monotonicNow = performance.now.bind(performance),
  eventLoopUtilization = performance.eventLoopUtilization.bind(performance),
  eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 }),
  cgroupSnapshot = () => readCgroupSnapshot(),
} = {}) => {
  let previousCpu = cpuUsage();
  let previousElu = eventLoopUtilization();
  let previousAt = monotonicNow();
  let previousCgroup = cgroupSnapshot();

  return {
    start() {
      eventLoopMonitor.enable();
    },
    sample() {
      const currentAt = monotonicNow();
      const elapsedMs = Math.max(1, currentAt - previousAt);
      const currentCpu = cpuUsage();
      const cpuDelta =
        Math.max(0, currentCpu.user - previousCpu.user) +
        Math.max(0, currentCpu.system - previousCpu.system);
      const currentElu = eventLoopUtilization();
      const eluDelta = eventLoopUtilization(currentElu, previousElu);
      const memory = memoryUsage();
      const currentCgroup = cgroupSnapshot();
      const containerCpuDelta =
        currentCgroup.cpuUsageUsec !== undefined &&
        previousCgroup.cpuUsageUsec !== undefined
          ? Math.max(0, currentCgroup.cpuUsageUsec - previousCgroup.cpuUsageUsec)
          : undefined;
      const throttledDelta =
        currentCgroup.throttledUsec !== undefined &&
        previousCgroup.throttledUsec !== undefined
          ? Math.max(0, currentCgroup.throttledUsec - previousCgroup.throttledUsec)
          : undefined;
      const containerMemoryPct =
        currentCgroup.memoryBytes !== undefined &&
        currentCgroup.memoryLimitBytes
          ? (currentCgroup.memoryBytes / currentCgroup.memoryLimitBytes) * 100
          : undefined;
      const metrics = {
        cpuPct:
          elapsedMs < 100 ? 0 : round((cpuDelta / (elapsedMs * 1000)) * 100),
        containerCpuPct:
          containerCpuDelta === undefined || elapsedMs < 100
            ? 0
            : round((containerCpuDelta / (elapsedMs * 1000)) * 100),
        containerMemoryLimitMb:
          currentCgroup.memoryLimitBytes === undefined
            ? 0
            : round(currentCgroup.memoryLimitBytes / ONE_MIB),
        containerMemoryMb:
          currentCgroup.memoryBytes === undefined
            ? 0
            : round(currentCgroup.memoryBytes / ONE_MIB),
        containerMemoryPct: round(containerMemoryPct || 0),
        cpuThrottledMs:
          throttledDelta === undefined ? 0 : round(throttledDelta / 1000),
        eventLoopLagMaxMs: round(eventLoopMonitor.max / 1e6),
        eventLoopLagP99Ms: round(eventLoopMonitor.percentile(99) / 1e6),
        eventLoopUtilizationPct: round(eluDelta.utilization * 100),
        heapUsedMb: round(memory.heapUsed / ONE_MIB),
        oomEvents: boundedInteger(currentCgroup.oomEvents, 0, 1_000_000_000) || 0,
        rssMb: round(memory.rss / ONE_MIB),
      };
      previousAt = currentAt;
      previousCpu = currentCpu;
      previousElu = currentElu;
      previousCgroup = currentCgroup;
      eventLoopMonitor.reset();
      return metrics;
    },
    stop() {
      eventLoopMonitor.disable();
    },
  };
};

const emptyCounters = () => ({
  apiRequests: 0,
  apiSlow: 0,
  callAccepted: 0,
  callOffers: 0,
  callRejected: 0,
  callRinging: 0,
  callTerminated: 0,
  callTimedOut: 0,
  callUpdateDeliveryFailed: 0,
  callUpdatesDelivered: 0,
  callUpdatesIgnored: 0,
  callUpdatesReceived: 0,
  connectionsConnected: 0,
  connectionsDisconnected: 0,
  connectionsErrors: 0,
  connectionsLoggedOut: 0,
  connectionsReconnectScheduled: 0,
  connectionsRestarted: 0,
  healthProbes: 0,
  messageBatches: 0,
  messageCollisions: 0,
  messageDelivered: 0,
  messageDeliveryFailed: 0,
  messageDuplicates: 0,
  messageIgnoredFromMe: 0,
  messageIgnoredMissing: 0,
  messageIgnoredMissingType: 0,
  messageIgnoredOther: 0,
  messagesReceived: 0,
});

const increment = (object, key, amount = 1) => {
  const safeAmount =
    Number.isInteger(amount) && amount > 0
      ? Math.min(amount, 1_000_000)
      : 0;
  object[key] = Math.min(
    Number.MAX_SAFE_INTEGER,
    (object[key] || 0) + safeAmount
  );
};

const normalizeMetrics = (metrics = {}) => ({
  cpuPct: round(boundedNumber(metrics.cpuPct, 0, 100_000) || 0),
  containerCpuPct: round(
    boundedNumber(metrics.containerCpuPct, 0, 100_000) || 0
  ),
  containerMemoryLimitMb: round(
    boundedNumber(metrics.containerMemoryLimitMb, 0, 1024 * 1024) || 0
  ),
  containerMemoryMb: round(
    boundedNumber(metrics.containerMemoryMb, 0, 1024 * 1024) || 0
  ),
  containerMemoryPct: round(
    boundedNumber(metrics.containerMemoryPct, 0, 100_000) || 0
  ),
  cpuThrottledMs: round(
    boundedNumber(metrics.cpuThrottledMs, 0, 86_400_000) || 0
  ),
  eventLoopLagMaxMs: round(
    boundedNumber(metrics.eventLoopLagMaxMs, 0, 86_400_000) || 0
  ),
  eventLoopLagP99Ms: round(
    boundedNumber(metrics.eventLoopLagP99Ms, 0, 86_400_000) || 0
  ),
  eventLoopUtilizationPct: round(
    boundedNumber(metrics.eventLoopUtilizationPct, 0, 100) || 0
  ),
  heapUsedMb: round(
    boundedNumber(metrics.heapUsedMb, 0, 1024 * 1024) || 0
  ),
  oomEvents:
    boundedInteger(metrics.oomEvents, 0, 1_000_000_000) || 0,
  rssMb: round(boundedNumber(metrics.rssMb, 0, 1024 * 1024) || 0),
});

const accumulateMetrics = (aggregate, sample) => {
  for (const key of Object.keys(sample)) {
    if (key === "cpuThrottledMs") {
      aggregate[key] = Math.min(
        86_400_000,
        round((aggregate[key] || 0) + sample[key])
      );
    } else {
      aggregate[key] = Math.max(aggregate[key] || 0, sample[key]);
    }
  }
};

const createRuntimeDiagnostics = ({
  logger = console,
  logLevel = "info",
  runId = createRunId(),
  heartbeatPath =
    process.env.HA_RUNTIME_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH,
  fsPromises = fs.promises,
  now = Date.now,
  metricsSampler = createSystemMetricsSampler(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  summaryIntervalMs = DEFAULT_SUMMARY_INTERVAL_MS,
  missingProbeMs = DEFAULT_MISSING_PROBE_MS,
  lagWarningMs = DEFAULT_LAG_WARNING_MS,
  warningCooldownMs = DEFAULT_WARNING_COOLDOWN_MS,
  slowApiMs = 2_000,
} = {}) => {
  const safeRunId = normalizeRunId(runId);
  const debugEnabled = logLevel === "debug";
  const counters = emptyCounters();
  const warningTimes = new Map();
  let apiActive = 0;
  let apiMaxMs = 0;
  let apiReadyAt;
  let clientStateProvider = () => ({});
  let heartbeatWriteFailures = 0;
  let inFlightTick;
  let interval;
  let lastMetrics = normalizeMetrics();
  let summaryMetrics = normalizeMetrics();
  let lastNativeProbeAt;
  let lastSummaryAt = now();
  let missingProbeWarningActive = false;
  let started = false;

  const warnRateLimited = (key, message, details) => {
    const timestamp = now();
    const lastWarning = warningTimes.get(key);
    if (
      lastWarning !== undefined &&
      timestamp - lastWarning < warningCooldownMs
    ) {
      return false;
    }
    warningTimes.set(key, timestamp);
    logger.warn?.(message, { runId: safeRunId, ...details });
    return true;
  };

  const getClientStateCounts = () => {
    const result = {
      connected: 0,
      connecting: 0,
      disconnected: 0,
      loggedOut: 0,
      pairing: 0,
      reconnecting: 0,
      restarting: 0,
      unknown: 0,
    };
    let states;
    try {
      states = clientStateProvider() || {};
    } catch {
      states = {};
    }
    for (const state of Object.values(states)) {
      const value = state?.state;
      if (!CLIENT_STATES.has(value)) {
        result.unknown += 1;
      } else if (value === "logged_out") {
        result.loggedOut += 1;
      } else {
        result[value] += 1;
      }
    }
    return result;
  };

  const heartbeatSnapshot = (timestamp) => ({
    schema: 1,
    run_id: safeRunId,
    updated_at_ms: timestamp,
    api_ready: apiReadyAt !== undefined,
    event_loop_lag_ms: lastMetrics.eventLoopLagP99Ms,
    event_loop_lag_max_ms: lastMetrics.eventLoopLagMaxMs,
    rss_mb: lastMetrics.rssMb,
    heap_used_mb: lastMetrics.heapUsedMb,
    cpu_pct: lastMetrics.cpuPct,
    container_cpu_pct: lastMetrics.containerCpuPct,
    container_memory_mb: lastMetrics.containerMemoryMb,
    container_memory_limit_mb: lastMetrics.containerMemoryLimitMb,
    container_memory_pct: lastMetrics.containerMemoryPct,
    cpu_throttled_ms: lastMetrics.cpuThrottledMs,
    oom_events: lastMetrics.oomEvents,
    event_loop_utilization_pct: lastMetrics.eventLoopUtilizationPct,
  });

  const writeHeartbeat = async (timestamp) => {
    const temporaryPath = `${heartbeatPath}.${safeRunId}.tmp`;
    try {
      await fsPromises.writeFile(
        temporaryPath,
        `${JSON.stringify(heartbeatSnapshot(timestamp))}\n`,
        { mode: 0o600 }
      );
      await fsPromises.rename(temporaryPath, heartbeatPath);
    } catch {
      heartbeatWriteFailures += 1;
      warnRateLimited(
        "heartbeat_write",
        "Runtime diagnostic heartbeat could not be written.",
        { failures: heartbeatWriteFailures }
      );
      try {
        await fsPromises.unlink(temporaryPath);
      } catch {
        // The temporary heartbeat is best-effort diagnostic state.
      }
    }
  };

  const emitSummary = (timestamp) => {
    const healthReference = lastNativeProbeAt ?? apiReadyAt;
    const lastHealthAgeMs =
      healthReference === undefined ? null : Math.max(0, timestamp - healthReference);
    const summary = {
      runId: safeRunId,
      intervalMs: Math.max(0, timestamp - lastSummaryAt),
      cpuPctMax: summaryMetrics.cpuPct,
      containerCpuPctMax: summaryMetrics.containerCpuPct,
      containerMemoryMbMax: summaryMetrics.containerMemoryMb,
      containerMemoryLimitMb: summaryMetrics.containerMemoryLimitMb,
      containerMemoryPctMax: summaryMetrics.containerMemoryPct,
      cpuThrottledMs: summaryMetrics.cpuThrottledMs,
      oomEvents: summaryMetrics.oomEvents,
      rssMbMax: summaryMetrics.rssMb,
      heapUsedMbMax: summaryMetrics.heapUsedMb,
      eventLoopLagP99MsMax: summaryMetrics.eventLoopLagP99Ms,
      eventLoopLagMaxMs: summaryMetrics.eventLoopLagMaxMs,
      eventLoopUtilizationPctMax: summaryMetrics.eventLoopUtilizationPct,
      heartbeatWriteFailures,
      lastHealthAgeMs,
      apiActive,
      apiMaxMs: round(apiMaxMs),
      clients: getClientStateCounts(),
      activity: { ...counters },
    };
    logger.debug?.(
      "WhatsApp add-on runtime diagnostics.",
      JSON.stringify(summary)
    );
    Object.assign(counters, emptyCounters());
    apiMaxMs = 0;
    summaryMetrics = normalizeMetrics();
    lastSummaryAt = timestamp;
  };

  const performTick = async ({ periodic = true } = {}) => {
    const timestamp = now();
    try {
      lastMetrics = normalizeMetrics(metricsSampler.sample());
      accumulateMetrics(summaryMetrics, lastMetrics);
    } catch {
      warnRateLimited(
        "metrics_sample",
        "Runtime metrics could not be sampled.",
        {}
      );
    }

    if (lastMetrics.eventLoopLagMaxMs >= lagWarningMs) {
      warnRateLimited(
        "event_loop_lag",
        "Serious Node.js event-loop lag detected.",
        {
          eventLoopLagMaxMs: lastMetrics.eventLoopLagMaxMs,
          eventLoopLagP99Ms: lastMetrics.eventLoopLagP99Ms,
          eventLoopUtilizationPct: lastMetrics.eventLoopUtilizationPct,
          cpuPct: lastMetrics.cpuPct,
          containerCpuPct: lastMetrics.containerCpuPct,
          containerMemoryPct: lastMetrics.containerMemoryPct,
          cpuThrottledMs: lastMetrics.cpuThrottledMs,
          oomEvents: lastMetrics.oomEvents,
          rssMb: lastMetrics.rssMb,
        }
      );
    }

    if (apiReadyAt !== undefined) {
      const reference = lastNativeProbeAt ?? apiReadyAt;
      const ageMs = timestamp - reference;
      if (ageMs >= missingProbeMs) {
        missingProbeWarningActive = true;
        warnRateLimited(
          "missing_health_probe",
          "Expected native container health requests are missing.",
          { lastHealthAgeMs: ageMs }
        );
      }
    }

    await writeHeartbeat(timestamp);
    if (
      periodic &&
      debugEnabled &&
      timestamp - lastSummaryAt >= summaryIntervalMs
    ) {
      emitSummary(timestamp);
    }
  };

  const tick = (options) => {
    if (inFlightTick) return inFlightTick;
    inFlightTick = performTick(options).finally(() => {
      inFlightTick = undefined;
    });
    return inFlightTick;
  };

  return {
    runId: safeRunId,
    async start() {
      if (started) return;
      started = true;
      metricsSampler.start?.();
      await tick({ periodic: false });
      interval = setIntervalFn(() => void tick(), sampleIntervalMs);
      interval?.unref?.();
    },
    async stop() {
      if (!started) return;
      started = false;
      if (interval !== undefined) clearIntervalFn(interval);
      if (inFlightTick) await inFlightTick;
      metricsSampler.stop?.();
      try {
        await fsPromises.unlink(heartbeatPath);
      } catch {
        // A missing or inaccessible heartbeat must not block shutdown.
      }
    },
    tick,
    markApiReady() {
      apiReadyAt = now();
    },
    setClientStateProvider(provider) {
      if (typeof provider === "function") clientStateProvider = provider;
    },
    recordNativeHealthProbe() {
      const timestamp = now();
      const previousReference = lastNativeProbeAt ?? apiReadyAt;
      lastNativeProbeAt = timestamp;
      increment(counters, "healthProbes");
      if (missingProbeWarningActive) {
        logger.info?.("Native container health requests resumed.", {
          runId: safeRunId,
          gapMs:
            previousReference === undefined
              ? null
              : Math.max(0, timestamp - previousReference),
        });
        missingProbeWarningActive = false;
      }
    },
    startApiRequest() {
      const startedAt = now();
      apiActive += 1;
      increment(counters, "apiRequests");
      let completed = false;
      return () => {
        if (completed) return;
        completed = true;
        apiActive = Math.max(0, apiActive - 1);
        const durationMs = Math.max(0, now() - startedAt);
        apiMaxMs = Math.max(apiMaxMs, durationMs);
        if (durationMs >= slowApiMs) increment(counters, "apiSlow");
      };
    },
    recordConnection(event) {
      const keys = {
        connected: "connectionsConnected",
        disconnected: "connectionsDisconnected",
        error: "connectionsErrors",
        logged_out: "connectionsLoggedOut",
        reconnect_scheduled: "connectionsReconnectScheduled",
        restarted: "connectionsRestarted",
      };
      if (keys[event]) increment(counters, keys[event]);
    },
    recordCallUpdate(status) {
      const keys = {
        accept: "callAccepted",
        offer: "callOffers",
        reject: "callRejected",
        ringing: "callRinging",
        terminate: "callTerminated",
        timeout: "callTimedOut",
      };
      increment(counters, "callUpdatesReceived");
      if (keys[status]) increment(counters, keys[status]);
    },
    recordCallDelivered(delivered) {
      increment(
        counters,
        delivered ? "callUpdatesDelivered" : "callUpdateDeliveryFailed"
      );
    },
    recordCallIgnored() {
      increment(counters, "callUpdatesIgnored");
    },
    recordMessageBatch(count) {
      increment(counters, "messageBatches");
      increment(counters, "messagesReceived", count);
    },
    recordMessageDelivered(delivered) {
      increment(
        counters,
        delivered ? "messageDelivered" : "messageDeliveryFailed"
      );
    },
    recordMessageIgnored(reason) {
      const key = {
        from_me: "messageIgnoredFromMe",
        missing_message: "messageIgnoredMissing",
        missing_message_type: "messageIgnoredMissingType",
      }[IGNORED_MESSAGE_REASONS.has(reason) ? reason : ""];
      increment(counters, key || "messageIgnoredOther");
    },
    recordMessageDuplicate() {
      increment(counters, "messageDuplicates");
    },
    recordMessageCollision() {
      increment(counters, "messageCollisions");
    },
  };
};

module.exports = {
  DEFAULT_HEALTH_FAILURE_PATH,
  DEFAULT_HEARTBEAT_PATH,
  HEALTH_FAILURE_CLASSIFICATIONS,
  createHealthFailureReport,
  createRunId,
  createRuntimeDiagnostics,
  createSystemMetricsSampler,
  formatHealthFailureNotification,
  readCgroupSnapshot,
  replayHealthcheckDiagnostics,
  sanitizeHealthRecord,
};
