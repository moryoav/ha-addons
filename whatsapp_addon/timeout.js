/** Bound upstream WhatsApp requests that have no timeout of their own. */

// Baileys waits for WhatsApp's answer without a timeout of its own. Stay below
// the integration's 10 second request timeout so a stuck query fails cleanly.
const QUERY_TIMEOUT_MS = 8_000;

/** Reject with a 408 status when the promise does not settle in time. */
const withTimeout = (promise, label, timeoutMs = QUERY_TIMEOUT_MS) => {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out.`), {
        statusCode: 408,
      }));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

module.exports = { QUERY_TIMEOUT_MS, withTimeout };
