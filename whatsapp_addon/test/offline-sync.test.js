const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { attachOfflineSyncMonitor } = require("../offline-sync");

const ib = (tag, attrs = {}) => ({ tag: "ib", attrs: {}, content: [{ tag, attrs }] });
const stanza = (tag, offline = true) => ({
  tag,
  attrs: { id: "fictional-id", from: "999999999999992@lid", ...(offline ? { offline: "0" } : {}) },
});

const harness = (options = {}) => {
  let time = 1_000;
  const timers = [];
  const reports = [];
  const socket = { ws: new EventEmitter(), ev: new EventEmitter() };
  const monitor = attachOfflineSyncMonitor({
    socket,
    onReport: (report) => reports.push(report),
    now: () => time,
    setTimeoutFn: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { if (timer) timer.cleared = true; },
    ...options,
  });
  return {
    socket, monitor, reports, timers,
    advance: (ms) => { time += ms; },
    frame: (value) => socket.ws.emit("frame", value),
    open: () => socket.ev.emit("connection.update", { connection: "open" }),
    close: () => socket.ev.emit("connection.update", { connection: "close" }),
  };
};

test("a finished backlog reports the announced and received counts only", () => {
  const h = harness();
  h.frame(ib("offline_preview", { count: "7", message: "3", receipt: "4", note: "text" }));
  h.open();
  for (const tag of ["message", "message", "receipt", "notification", "call"]) h.frame(stanza(tag));
  h.frame(stanza("message", false)); // Live traffic is not part of the backlog.
  h.frame(stanza("presence"));
  h.advance(2_500);
  h.frame(ib("offline", { count: "5" }));
  assert.deepEqual(h.reports, [{
    phase: "finished",
    announced: { count: 7, message: 3, receipt: 4 },
    received: { message: 2, receipt: 1, notification: 1, call: 1 },
    count: 5,
    durationMs: 2_500,
  }]);
  assert.equal(h.timers[0].cleared, true);
  assert.doesNotMatch(JSON.stringify(h.reports), /fictional|999999/);
  h.monitor.close();
});

test("a backlog that never ends is reported once, after the timeout from open", () => {
  const h = harness();
  h.frame(ib("offline_preview", { count: "150" }));
  h.frame(stanza("message"));
  assert.equal(h.timers.length, 0); // The wait starts when the connection opens.
  h.open();
  h.open();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 60_000);
  h.advance(60_000);
  h.timers[0].callback();
  assert.deepEqual(h.reports, [{
    phase: "unfinished",
    announced: { count: 150 },
    received: { message: 1, receipt: 0, notification: 0, call: 0 },
    waitedMs: 60_000,
  }]);
  // If WhatsApp ends the backlog later, that is reported too.
  h.frame(ib("offline", { count: "150" }));
  assert.equal(h.reports[1].phase, "finished");
  h.frame(ib("offline", { count: "150" }));
  assert.equal(h.reports.length, 2);
  h.monitor.close();
});

test("a backlog that ends before the connection opens starts no timer", () => {
  const h = harness();
  h.frame(ib("offline", { count: "0" }));
  h.open();
  assert.equal(h.timers.length, 0);
  assert.equal(h.reports.length, 1);
  h.monitor.close();
});

test("closing the socket stops the timer and removes both listeners", () => {
  const h = harness();
  h.open();
  h.close();
  assert.equal(h.timers[0].cleared, true);
  h.timers[0].callback();
  h.frame(ib("offline"));
  assert.deepEqual(h.reports, []);
  assert.equal(h.socket.ws.listenerCount("frame"), 0);
  assert.equal(h.socket.ev.listenerCount("connection.update"), 0);
});

test("malformed frames and a failing callback never throw", () => {
  const h = harness({ onReport: () => { throw new Error("logger down"); } });
  for (const value of [null, undefined, "text", Buffer.from("raw"), {},
    { tag: "ib" }, { tag: "ib", content: [null, {}] }, { tag: "message" },
    { tag: "message", attrs: null }]) {
    assert.doesNotThrow(() => h.frame(value));
  }
  assert.doesNotThrow(() => h.frame(ib("offline", { count: "x".repeat(20) })));
  assert.doesNotThrow(() => h.socket.ev.emit("connection.update", null));
  h.monitor.close();
});

test("unsupported sockets are ignored and a bad timeout is rejected", () => {
  for (const socket of [undefined, {}, { ws: new EventEmitter() }, { ev: new EventEmitter() }]) {
    assert.equal(attachOfflineSyncMonitor({ socket }), undefined);
  }
  for (const timeoutMs of [0, -1, 1.5, "60000"]) {
    assert.throws(() => harness({ timeoutMs }), TypeError);
  }
});

test("the real timer does not keep the process alive", () => {
  let timer;
  const socket = { ws: new EventEmitter(), ev: new EventEmitter() };
  const monitor = attachOfflineSyncMonitor({
    socket,
    setTimeoutFn: (...args) => (timer = setTimeout(...args)),
  });
  socket.ev.emit("connection.update", { connection: "open" });
  assert.equal(timer.hasRef(), false);
  monitor.close();
});
