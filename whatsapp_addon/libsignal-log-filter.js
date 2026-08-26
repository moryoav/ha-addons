const DEFAULT_SUMMARY_INTERVAL_MS = 60 * 1000;
const DEFAULT_STORM_FAILED_DECRYPT_THRESHOLD = 10;
const DEFAULT_STORM_SESSION_ERROR_THRESHOLD = 100;

const SESSION_LIFECYCLE_MESSAGES = new Set([
  "Closing open session in favor of incoming prekey bundle",
  "Closing stale open session for new outgoing prekey bundle",
  "Closing session:",
  "Opening session:",
  "Removing old closed session:",
  "Session already closed",
  "Session already open",
  "Decrypted message with closed session.",
]);

const createCounts = () => ({
  badMacSessionErrors: 0,
  failedDecryptMessages: 0,
  messageCounterSessionErrors: 0,
  sessionLifecycleLogs: 0,
});

const asString = (value) => (typeof value === "string" ? value : "");

const includesBadMac = (args) =>
  args.some((arg) => typeof arg === "string" && arg.includes("Bad MAC"));

const includesMessageCounterError = (args) =>
  args.some(
    (arg) =>
      typeof arg === "string" &&
      (arg.includes("MessageCounterError") ||
        arg.includes("Key used already or never filled"))
  );

const classifyLibsignalNoise = (method, args) => {
  const first = asString(args[0]);

  if (
    method === "error" &&
    first === "Failed to decrypt message with any known session..."
  ) {
    return "failedDecryptMessages";
  }

  if (
    method === "error" &&
    first.startsWith("Session error:") &&
    includesBadMac(args)
  ) {
    return "badMacSessionErrors";
  }

  if (
    method === "error" &&
    first.startsWith("Session error:") &&
    includesMessageCounterError(args)
  ) {
    return "messageCounterSessionErrors";
  }

  if ((method === "info" || method === "warn") && SESSION_LIFECYCLE_MESSAGES.has(first)) {
    return "sessionLifecycleLogs";
  }

  return null;
};

const createLibsignalLogFilter = ({
  consoleObj = console,
  logger,
  summaryIntervalMs = DEFAULT_SUMMARY_INTERVAL_MS,
  stormFailedDecryptThreshold = DEFAULT_STORM_FAILED_DECRYPT_THRESHOLD,
  stormSessionErrorThreshold = DEFAULT_STORM_SESSION_ERROR_THRESHOLD,
  onDecryptStorm,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) => {
  const counts = createCounts();
  const original = {};
  let installed = false;
  let summaryTimer;
  let stormHandler = onDecryptStorm;
  let stormReported = false;

  const getSummary = () => ({
    badMacSessionErrors: counts.badMacSessionErrors,
    failedDecryptMessages: counts.failedDecryptMessages,
    messageCounterSessionErrors: counts.messageCounterSessionErrors,
    sessionLifecycleLogs: counts.sessionLifecycleLogs,
    total:
      counts.badMacSessionErrors +
      counts.failedDecryptMessages +
      counts.messageCounterSessionErrors +
      counts.sessionLifecycleLogs,
  });

  const resetCounts = () => {
    Object.assign(counts, createCounts());
  };

  const resetStormDetection = () => {
    resetCounts();
    stormReported = false;
  };

  const maybeReportDecryptStorm = () => {
    if (stormReported || typeof stormHandler !== "function") return false;

    const sessionErrors =
      counts.badMacSessionErrors + counts.messageCounterSessionErrors;
    if (
      counts.failedDecryptMessages < stormFailedDecryptThreshold ||
      sessionErrors < stormSessionErrorThreshold
    ) {
      return false;
    }

    stormReported = true;
    try {
      stormHandler(getSummary());
    } catch {
      logger?.warn?.("Libsignal recovery handler failed.");
    }
    return true;
  };

  const flushSummary = () => {
    const summary = getSummary();
    if (summary.total === 0) return false;

    if (logger?.info) {
      logger.info("Suppressed libsignal console noise.", summary);
    }

    resetStormDetection();
    return true;
  };

  const install = () => {
    if (installed) return;

    for (const method of ["error", "warn", "info"]) {
      original[method] = consoleObj[method];
      consoleObj[method] = (...args) => {
        const category = classifyLibsignalNoise(method, args);
        if (category) {
          counts[category] += 1;
          maybeReportDecryptStorm();
          return;
        }

        return original[method].apply(consoleObj, args);
      };
    }

    if (summaryIntervalMs > 0) {
      summaryTimer = setIntervalFn(flushSummary, summaryIntervalMs);
      if (summaryTimer?.unref) summaryTimer.unref();
    }

    installed = true;
  };

  const uninstall = () => {
    if (!installed) return;

    for (const method of Object.keys(original)) {
      consoleObj[method] = original[method];
    }

    if (summaryTimer) {
      clearIntervalFn(summaryTimer);
      summaryTimer = undefined;
    }

    installed = false;
  };

  return {
    flushSummary,
    getSummary,
    install,
    resetStormDetection,
    setDecryptStormHandler(handler) {
      stormHandler = typeof handler === "function" ? handler : undefined;
      maybeReportDecryptStorm();
    },
    uninstall,
  };
};

let defaultFilter;

const installLibsignalLogFilter = (options = {}) => {
  if (!defaultFilter) {
    defaultFilter = createLibsignalLogFilter(options);
    defaultFilter.install();
  }

  return defaultFilter;
};

module.exports = {
  DEFAULT_STORM_FAILED_DECRYPT_THRESHOLD,
  DEFAULT_STORM_SESSION_ERROR_THRESHOLD,
  DEFAULT_SUMMARY_INTERVAL_MS,
  createLibsignalLogFilter,
  installLibsignalLogFilter,
};
