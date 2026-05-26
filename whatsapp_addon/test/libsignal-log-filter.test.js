const assert = require("assert");
const { createLibsignalLogFilter } = require("../libsignal-log-filter");

const passed = {
  error: [],
  warn: [],
  info: [],
};

const consoleObj = {
  error: (...args) => passed.error.push(args),
  warn: (...args) => passed.warn.push(args),
  info: (...args) => passed.info.push(args),
};

const summaries = [];
const logger = {
  info: (...args) => summaries.push(args),
};

const filter = createLibsignalLogFilter({
  consoleObj,
  logger,
  summaryIntervalMs: 0,
});

filter.install();

consoleObj.error("Failed to decrypt message with any known session...");
consoleObj.error(
  "Session error:Error: Bad MAC",
  "Error: Bad MAC\n    at SessionCipher.doDecryptWhisperMessage"
);
consoleObj.info("Closing session:", { secret: "session object should not log" });
consoleObj.info("Removing old closed session:", {
  secret: "old session should not log",
});
consoleObj.warn("Closing open session in favor of incoming prekey bundle");

consoleObj.error("Real error", { code: 123 });
consoleObj.warn("Real warning");
consoleObj.info("Real info");

assert.deepStrictEqual(passed.error, [["Real error", { code: 123 }]]);
assert.deepStrictEqual(passed.warn, [["Real warning"]]);
assert.deepStrictEqual(passed.info, [["Real info"]]);

assert.deepStrictEqual(filter.getSummary(), {
  badMacSessionErrors: 1,
  failedDecryptMessages: 1,
  sessionLifecycleLogs: 3,
  total: 5,
});

assert.strictEqual(filter.flushSummary(), true);
assert.strictEqual(summaries.length, 1);
assert.strictEqual(summaries[0][0], "Suppressed libsignal console noise.");
assert.deepStrictEqual(summaries[0][1], {
  badMacSessionErrors: 1,
  failedDecryptMessages: 1,
  sessionLifecycleLogs: 3,
  total: 5,
});

const summaryJson = JSON.stringify(summaries);
assert.strictEqual(summaryJson.includes("Bad MAC"), false);
assert.strictEqual(summaryJson.includes("SessionCipher"), false);
assert.strictEqual(summaryJson.includes("session object should not log"), false);
assert.strictEqual(summaryJson.includes("old session should not log"), false);

assert.strictEqual(filter.flushSummary(), false);

filter.uninstall();
consoleObj.info("Restored info");
assert.deepStrictEqual(passed.info[1], ["Restored info"]);

console.log("libsignal-log-filter tests passed");
