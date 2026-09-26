const DEFAULT_OFFLINE_SYNC_TIMEOUT_MS = 60_000;
const COUNTED_TAGS = ["message", "receipt", "notification", "call"];
const MAX_COUNT = 1_000_000_000;

// Keeps only small numeric attributes, such as the counts in <offline_preview>.
const numericAttrs = (attrs) => {
  const result = {};
  if (!attrs || typeof attrs !== "object") return result;
  for (const [key, value] of Object.entries(attrs).slice(0, 16)) {
    if (/^[a-z_]{1,32}$/.test(key) && typeof value === "string" &&
        /^\d{1,9}$/.test(value)) {
      result[key] = Number(value);
    }
  }
  return result;
};

/**
 * Reports how WhatsApp delivers the offline backlog after a connection opens.
 * WhatsApp ends the backlog with <ib><offline/></ib>. If that never comes, the
 * socket stops receiving new messages until it reconnects. Only counts are
 * kept: no identifiers or message content are read.
 */
const attachOfflineSyncMonitor = ({
  socket,
  onReport,
  timeoutMs = DEFAULT_OFFLINE_SYNC_TIMEOUT_MS,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  const ws = socket?.ws;
  const ev = socket?.ev;
  if (typeof ws?.on !== "function" || typeof ev?.on !== "function") {
    return undefined;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Invalid offline sync timeout.");
  }

  const startedAt = now();
  const received = Object.fromEntries(COUNTED_TAGS.map((tag) => [tag, 0]));
  let announced;
  let opened = false;
  let finished = false;
  let closed = false;
  let timer;

  const report = (phase, details) => {
    try {
      onReport?.({
        phase,
        announced: announced ? { ...announced } : undefined,
        received: { ...received },
        ...details,
      });
    } catch {
      // Logging must not affect message processing.
    }
  };

  const onFrame = (frame) => {
    try {
      if (closed || !frame || typeof frame !== "object" ||
          frame instanceof Uint8Array) return;
      if (frame.tag === "ib") {
        if (!Array.isArray(frame.content)) return;
        for (const child of frame.content) {
          if (child?.tag === "offline_preview") {
            announced = numericAttrs(child.attrs);
          } else if (child?.tag === "offline" && !finished) {
            finished = true;
            clearTimeoutFn(timer);
            report("finished", {
              count: numericAttrs(child.attrs).count,
              durationMs: Math.max(0, now() - startedAt),
            });
          }
        }
        return;
      }
      if (!finished && COUNTED_TAGS.includes(frame.tag) && frame.attrs &&
          Object.prototype.hasOwnProperty.call(frame.attrs, "offline")) {
        received[frame.tag] = Math.min(received[frame.tag] + 1, MAX_COUNT);
      }
    } catch {
      // Malformed frames are Baileys' business, never ours.
    }
  };

  const onConnection = (update) => {
    if (update?.connection === "close") {
      close();
      return;
    }
    if (update?.connection !== "open" || opened) return;
    opened = true;
    if (finished) return;
    timer = setTimeoutFn(() => {
      if (!closed && !finished) {
        report("unfinished", { waitedMs: Math.max(0, now() - startedAt) });
      }
    }, timeoutMs);
    timer?.unref?.();
  };

  const removeListener = (emitter, event, listener) => {
    if (typeof emitter.off === "function") emitter.off(event, listener);
    else emitter.removeListener?.(event, listener);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeoutFn(timer);
    removeListener(ws, "frame", onFrame);
    removeListener(ev, "connection.update", onConnection);
  };

  ws.on("frame", onFrame);
  ev.on("connection.update", onConnection);
  return { close };
};

module.exports = {
  DEFAULT_OFFLINE_SYNC_TIMEOUT_MS,
  attachOfflineSyncMonitor,
};
