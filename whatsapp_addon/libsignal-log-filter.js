const DEFAULT_SUMMARY_INTERVAL_MS = 60 * 1000;

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
  sessionLifecycleLogs: 0,
});

const asString = (value) => (typeof value === "string" ? value : "");

const includesBadMac = (args) =>
  args.some((arg) => typeof arg === "string" && arg.includes("Bad MAC"));

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

  if ((method === "info" || method === "warn") && SESSION_LIFECYCLE_MESSAGES.has(first)) {
    return "sessionLifecycleLogs";
  }

  return null;
};

const createLibsignalLogFilter = ({
  consoleObj = console,
  logger,
  summaryIntervalMs = DEFAULT_SUMMARY_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) => {
  const counts = createCounts();
  const original = {};
  let installed = false;
  let summaryTimer;

  const getSummary = () => ({
    badMacSessionErrors: counts.badMacSessionErrors,
    failedDecryptMessages: counts.failedDecryptMessages,
    sessionLifecycleLogs: counts.sessionLifecycleLogs,
    total:
      counts.badMacSessionErrors +
      counts.failedDecryptMessages +
      counts.sessionLifecycleLogs,
  });

  const resetCounts = () => {
    Object.assign(counts, createCounts());
  };

  const flushSummary = () => {
    const summary = getSummary();
    if (summary.total === 0) return false;

    if (logger?.info) {
      logger.info("Suppressed libsignal console noise.", summary);
    }

    resetCounts();
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
  DEFAULT_SUMMARY_INTERVAL_MS,
  createLibsignalLogFilter,
  installLibsignalLogFilter,
};
