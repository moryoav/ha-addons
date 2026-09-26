const DEFAULT_FLUSH_INTERVAL_MS = 1_000;

/**
 * Baileys 6.7.23 turns its event buffer on for every processed message, but
 * only turns it off when WhatsApp ends the offline backlog or a live stanza
 * arrives. Until then messages.upsert never fires, so Home Assistant and the
 * LID receipt workaround see nothing. Baileys 7 flushes on its own. This does
 * the same from outside: events held for a whole interval are released.
 */
const attachEventBufferFlush = ({
  socket,
  intervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  onFlush,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) => {
  const ev = socket?.ev;
  if (typeof ev?.isBuffering !== "function" || typeof ev.flush !== "function") {
    return undefined;
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError("Invalid flush interval.");
  }

  let held = false;
  let timer = setIntervalFn(() => {
    try {
      if (!ev.isBuffering()) {
        held = false;
        return;
      }
      // Wait one full interval first, so Baileys' own short buffer around a
      // live stanza still ends the normal way.
      if (!held) {
        held = true;
        return;
      }
      held = false;
      if (ev.flush()) onFlush?.();
    } catch {
      // The watchdog must never interrupt the socket.
    }
  }, intervalMs);
  timer?.unref?.();

  return {
    close() {
      if (timer === undefined) return;
      clearIntervalFn(timer);
      timer = undefined;
    },
  };
};

module.exports = { DEFAULT_FLUSH_INTERVAL_MS, attachEventBufferFlush };
