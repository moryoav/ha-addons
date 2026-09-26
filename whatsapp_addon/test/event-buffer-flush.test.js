const assert = require("node:assert/strict");
const test = require("node:test");
const { attachEventBufferFlush } = require("../event-buffer-flush");

// A Baileys-like event buffer and a manual interval, so every tick is explicit.
const harness = (options = {}) => {
  const state = { buffering: false, flushes: 0, released: 0, cleared: 0 };
  let tick;
  const socket = {
    ev: {
      isBuffering: () => state.buffering,
      flush: () => {
        if (!state.buffering) return false;
        state.buffering = false;
        state.flushes += 1;
        return true;
      },
    },
  };
  const watch = attachEventBufferFlush({
    socket,
    onFlush: () => { state.released += 1; },
    setIntervalFn: (callback, ms) => { tick = callback; state.intervalMs = ms; return {}; },
    clearIntervalFn: () => { state.cleared += 1; },
    ...options,
  });
  return { state, socket, watch, tick: () => tick() };
};

test("events held for a whole interval are released", () => {
  const h = harness();
  assert.equal(h.state.intervalMs, 1000);
  h.state.buffering = true;
  h.tick();
  assert.equal(h.state.flushes, 0); // Baileys may still end its own short buffer.
  h.tick();
  assert.equal(h.state.flushes, 1);
  assert.equal(h.state.released, 1);
  h.tick();
  assert.equal(h.state.flushes, 1); // Nothing is held any more.
  h.watch.close();
});

test("a buffer that Baileys ends by itself is left alone", () => {
  const h = harness();
  h.state.buffering = true;
  h.tick();
  h.state.buffering = false;
  h.tick();
  h.state.buffering = true;
  h.tick();
  assert.equal(h.state.flushes, 0);
  h.tick();
  assert.equal(h.state.flushes, 1);
  h.watch.close();
});

test("a flush that releases nothing is not reported", () => {
  const h = harness();
  h.socket.ev.flush = () => false;
  h.state.buffering = true;
  h.tick();
  h.tick();
  assert.equal(h.state.released, 0);
  h.watch.close();
});

test("errors from Baileys or the callback never escape the timer", () => {
  const h = harness({ onFlush: () => { throw new Error("listener failed"); } });
  h.state.buffering = true;
  h.tick();
  assert.doesNotThrow(() => h.tick());
  assert.equal(h.state.flushes, 1);
  h.socket.ev.isBuffering = () => { throw new Error("broken buffer"); };
  assert.doesNotThrow(() => h.tick());
  h.watch.close();
});

test("close stops the timer once", () => {
  const h = harness();
  h.watch.close();
  h.watch.close();
  assert.equal(h.state.cleared, 1);
});

test("sockets without a Baileys event buffer are ignored, and bad intervals rejected", () => {
  for (const socket of [undefined, {}, { ev: {} }, { ev: { isBuffering() {} } }]) {
    assert.equal(attachEventBufferFlush({ socket }), undefined);
  }
  for (const intervalMs of [0, -1, 1.5, Number.NaN, "1000"]) {
    assert.throws(() => harness({ intervalMs }), TypeError);
  }
});

test("the timer does not keep the process alive", () => {
  let timer;
  const watch = attachEventBufferFlush({
    socket: { ev: { isBuffering: () => false, flush: () => false } },
    setIntervalFn: (...args) => (timer = setInterval(...args)),
  });
  assert.equal(timer.hasRef(), false);
  watch.close();
});
