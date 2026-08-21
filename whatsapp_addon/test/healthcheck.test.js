const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ADDON_ROOT = path.resolve(__dirname, "..");
const HEALTHCHECK = path.join(ADDON_ROOT, "healthcheck.sh");

const toShellPath = (filePath) => {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  if (process.platform !== "win32") return normalized;
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) throw new Error(`Cannot map path into WSL: ${filePath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
};

const shellAvailable = (() => {
  const command = process.platform === "win32" ? "wsl.exe" : "sh";
  const args =
    process.platform === "win32" ? ["--exec", "/bin/sh", "-c", ":"] : ["-c", ":"];
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
})();

const createHarness = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ha-whatsapp-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fakeCurl = path.join(root, "fake-curl.sh");
  const pending = path.join(root, "healthcheck-failures.pending");
  const state = path.join(root, "healthcheck-state");
  const heartbeat = path.join(root, "runtime-heartbeat.json");
  const argsFile = path.join(root, "curl-args.txt");
  fs.writeFileSync(
    fakeCurl,
    `#!/bin/sh
: > "$FAKE_CURL_ARGS_FILE"
for argument do
  printf '%s\\n' "$argument" >> "$FAKE_CURL_ARGS_FILE"
done
printf '%s' "$FAKE_CURL_METRICS"
exit "$FAKE_CURL_EXIT"
`,
    { mode: 0o700 }
  );

  const shellPaths = Object.fromEntries(
    Object.entries({ fakeCurl, pending, state, heartbeat, argsFile }).map(
      ([key, value]) => [key, toShellPath(value)]
    )
  );

  const run = ({ exitCode, maxRecords = 50, metrics }) => {
    const probeEnv = {
      FAKE_CURL_ARGS_FILE: shellPaths.argsFile,
      FAKE_CURL_EXIT: String(exitCode),
      FAKE_CURL_METRICS: metrics,
      HA_HEALTH_CURL_BIN: shellPaths.fakeCurl,
      HA_HEALTH_FAILURE_PATH: shellPaths.pending,
      HA_HEALTH_LOG_TARGET: "/dev/null",
      HA_HEALTH_MAX_RECORDS: String(maxRecords),
      HA_HEALTH_STATE_PATH: shellPaths.state,
      HA_HEALTH_URL: "http://127.0.0.1:3000/health?token=never-log-this",
      HA_RUNTIME_HEARTBEAT_PATH: shellPaths.heartbeat,
    };

    if (process.platform === "win32") {
      return spawnSync(
        "wsl.exe",
        [
          "--exec",
          "/usr/bin/env",
          ...Object.entries(probeEnv).map(
            ([key, value]) => `${key}=${value}`
          ),
          "/bin/sh",
          "-c",
          'chmod +x "$1" && exec /bin/sh "$2"',
          "healthcheck-test",
          shellPaths.fakeCurl,
          toShellPath(HEALTHCHECK),
        ],
        { encoding: "utf8" }
      );
    }
    return spawnSync("sh", [HEALTHCHECK], {
      encoding: "utf8",
      env: { ...process.env, ...probeEnv },
    });
  };

  const records = () => {
    if (!fs.existsSync(pending)) return [];
    return fs
      .readFileSync(pending, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };

  return { argsFile, heartbeat, pending, records, run, state };
};

test(
  "health probe records safe failure details and sends the native probe header",
  { skip: !shellAvailable },
  (t) => {
    const harness = createHarness(t);
    fs.writeFileSync(
      harness.heartbeat,
      JSON.stringify({
        schema: 1,
        run_id: "private-run-id-must-not-be-copied",
        updated_at_ms: Date.now(),
        event_loop_lag_ms: 12,
        event_loop_lag_max_ms: 34,
        rss_mb: 90.5,
        heap_used_mb: 45.25,
        cpu_pct: 7.5,
        event_loop_utilization_pct: 8.75,
        container_cpu_pct: 6.5,
        container_memory_mb: 96.5,
        container_memory_limit_mb: 1024,
        container_memory_pct: 9.4,
        cpu_throttled_ms: 11,
        oom_events: 0,
      })
    );

    const result = harness.run({
      exitCode: 28,
      metrics: "000 0.002 0.000 5.001",
    });
    assert.equal(result.status, 1, result.stderr);

    const [record] = harness.records();
    assert.ok(record, `probe did not persist a record: ${result.stderr}`);
    assert.equal(record.schema, 1);
    assert.equal(record.type, "failure");
    assert.equal(record.classification, "response_timeout");
    assert.equal(record.curl_exit, 28);
    assert.equal(record.http_code, 0);
    assert.equal(record.time_connect_ms, 2);
    assert.equal(record.time_starttransfer_ms, 0);
    assert.equal(record.time_total_ms, 5001);
    assert.equal(record.streak, 1);
    assert.equal(record.event_loop_lag_ms, 12);
    assert.equal(record.event_loop_lag_max_ms, 34);
    assert.equal(record.rss_mb, 90.5);
    assert.equal(record.container_memory_limit_mb, 1024);
    assert.equal(record.cpu_throttled_ms, 11);
    assert.equal(record.oom_events, 0);
    assert.ok(record.heartbeat_age_ms >= 0);
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const serialized = `${fs.readFileSync(harness.pending, "utf8")} ${
      result.stderr
    }`;
    assert.ok(!serialized.includes("never-log-this"));
    assert.ok(!serialized.includes("private-run-id"));
    assert.equal(fs.readFileSync(harness.state, "utf8").trim(), "1");

    const curlArgs = fs.readFileSync(harness.argsFile, "utf8").split(/\r?\n/);
    const maxTimeIndex = curlArgs.indexOf("--max-time");
    assert.notEqual(maxTimeIndex, -1);
    assert.equal(curlArgs[maxTimeIndex + 1], "5");
    const headerIndex = curlArgs.indexOf("--header");
    assert.notEqual(headerIndex, -1);
    assert.equal(curlArgs[headerIndex + 1], "X-HA-Healthcheck: docker");
    assert.ok(curlArgs.includes("--output"));
    assert.ok(curlArgs.includes("/dev/null"));
  }
);

test(
  "health probe records one recovery and clears its failure streak",
  { skip: !shellAvailable },
  (t) => {
    const harness = createHarness(t);
    assert.equal(
      harness.run({ exitCode: 7, metrics: "000 0.000 0.000 0.001" }).status,
      1
    );
    assert.equal(
      harness.run({ exitCode: 28, metrics: "000 0.001 0.000 5.000" })
        .status,
      1
    );
    assert.equal(
      harness.run({ exitCode: 0, metrics: "200 0.001 0.002 0.003" }).status,
      0
    );

    const recordsAfterRecovery = harness.records();
    assert.deepEqual(
      recordsAfterRecovery.map((record) => record.type),
      ["failure", "failure", "recovery"]
    );
    assert.deepEqual(
      recordsAfterRecovery.map((record) => record.classification),
      ["connection_failed", "response_timeout", undefined]
    );
    assert.equal(recordsAfterRecovery[2].prior_streak, 2);
    assert.equal(recordsAfterRecovery[2].time_total_ms, 3);
    assert.equal(fs.existsSync(harness.state), false);

    assert.equal(
      harness.run({ exitCode: 0, metrics: "200 0.001 0.002 0.003" }).status,
      0
    );
    assert.equal(harness.records().length, 3);
  }
);

test(
  "health probe bounds the pending JSONL file to its newest records",
  { skip: !shellAvailable },
  (t) => {
    const harness = createHarness(t);
    for (let index = 0; index < 5; index += 1) {
      const result = harness.run({
        exitCode: 52,
        maxRecords: 3,
        metrics: "000 0.001 0.002 0.003",
      });
      assert.equal(result.status, 1);
    }

    const records = harness.records();
    assert.equal(records.length, 3);
    assert.deepEqual(
      records.map((record) => record.streak),
      [3, 4, 5]
    );
    assert.ok(records.every((record) => record.classification === "empty_response"));
  }
);
