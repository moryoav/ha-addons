const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { normalizeRecipient, recordingMatches, recordingUrl, selectAccount, voiceAvailability, request } =
  require("../webui/workspace");

// Generated test targets are synthetic, not saved account details.
const PHONE_DIGITS = "2".repeat(9);
const PHONE_JID = `${PHONE_DIGITS}@s.whatsapp.net`;
const LID = `${"3".repeat(18)}@lid`;
const FILENAME = `20261026T090000Z-${"a".repeat(32)}.wav`;

test("recipient entry normalizes phone formatting without losing user IDs", () => {
  for (const value of [PHONE_DIGITS, "+" + PHONE_DIGITS, `  +${PHONE_DIGITS}  `,
    `+${PHONE_DIGITS.slice(0, 3)} (${PHONE_DIGITS.slice(3, 6)})-${PHONE_DIGITS.slice(6)}`]) {
    assert.equal(normalizeRecipient(value), PHONE_JID);
  }
  assert.equal(normalizeRecipient(" " + PHONE_JID + " "), PHONE_JID);
  assert.equal(normalizeRecipient(LID), LID);
  const deviceJid = `${PHONE_DIGITS}:12345@s.whatsapp.net`;
  assert.equal(normalizeRecipient(deviceJid), deviceJid);
  assert.equal(normalizeRecipient("2".repeat(5)), `${"2".repeat(5)}@s.whatsapp.net`);
  assert.equal(normalizeRecipient("2".repeat(15)), `${"2".repeat(15)}@s.whatsapp.net`);
  assert.equal(normalizeRecipient(`${"3".repeat(30)}@lid`), `${"3".repeat(30)}@lid`);
  assert.equal(normalizeRecipient(`${"3".repeat(31)}@lid`), `${"3".repeat(31)}@lid`);
});

test("recipient entry rejects groups, malformed IDs, and arbitrary text", () => {
  for (const value of ["", "  ", null, undefined, {}, [], 42,
    "Sample recipient", "+" + PHONE_DIGITS + "letters", "++" + PHONE_DIGITS,
    "0" + PHONE_DIGITS, "2".repeat(4), "2".repeat(16),
    `${PHONE_DIGITS}@g.us`, `${PHONE_DIGITS}@broadcast`,
    `${PHONE_DIGITS}:123456@s.whatsapp.net`, `${"3".repeat(32)}@lid`,
    `https://example.invalid/${PHONE_DIGITS}`]) {
    assert.throws(() => normalizeRecipient(value), TypeError);
  }
});

test("recording links stay relative to protected voice routes", () => {
  assert.equal(recordingUrl(FILENAME), `voice/recordings/${FILENAME}`);
  assert.equal(recordingUrl(FILENAME, true), `voice/recordings/${FILENAME}?download=1`);
  for (const value of ["", null, undefined, {}, "../" + FILENAME,
    "%2e%2e%2f" + FILENAME, "/" + FILENAME, FILENAME + "?download=1",
    FILENAME.replace(".wav", ".mp3"), FILENAME.replace(/a/g, "A"),
    "https://example.invalid/" + FILENAME, FILENAME + "\0"]) {
    assert.throws(() => recordingUrl(value), TypeError);
  }
});

test("recording search matches local display dates and ISO dates", () => {
  const recording = { created_at: "2026-10-26T09:00:00.000Z" };
  const displayed = new Date(recording.created_at).toLocaleString();
  assert.equal(recordingMatches(recording, "2026-10-26"), true);
  assert.equal(recordingMatches(recording, " 2026-10-26 "), true);
  assert.equal(recordingMatches(recording, displayed), true);
  assert.equal(recordingMatches(recording, "2026-10-25"), false);
  assert.equal(recordingMatches(recording, "not a date"), false);
  assert.equal(recordingMatches(recording, ""), true);
  assert.equal(recordingMatches({ created_at: "invalid" }, "2026"), false);
  assert.equal(recordingMatches({}, "2026"), false);
  assert.equal(recordingMatches({ created_at: "invalid" }, ""), true);
});

test("account selection retains valid choices and initially prefers the calling account", () => {
  const clients = [{ id: "first" }, { id: "calling" }, { id: "last" }];
  assert.equal(selectAccount(clients, "last", "calling"), "last");
  assert.equal(selectAccount(clients, null, "calling"), "calling");
  assert.equal(selectAccount(clients, "removed", "calling"), "calling");
  assert.equal(selectAccount(clients, "removed", "missing"), "first");
  assert.equal(selectAccount([], "removed", "missing"), null);
});

test("voice availability combines account, socket, recovery, and stale status", () => {
  const status = { clients: [{ id: "calling", state: "connected" }],
    recovery: { active: false } };
  const voice = { client_id: "calling", live_mode: true, configured: true,
    connected: true, active: false };
  const cases = [
    { name: "connected calling account", expected: { ready: true, label: "Ready for calls" } },
    { name: "active call", voice: { ...voice, active: true },
      expected: { ready: true, label: "Call in progress" } },
    { name: "recovery overrides a stale connected socket",
      status: { ...status, recovery: { active: true } },
      expected: { ready: false, label: "Paused for recovery" } },
    { name: "account recovery state without a global recovery flag",
      status: { ...status, clients: [{ id: "calling", state: "recovery_paused" }] },
      expected: { ready: false, label: "Paused for recovery" } },
    { name: "disconnected account with a stale connected socket",
      status: { ...status, clients: [{ id: "calling", state: "disconnected" }] },
      expected: { ready: false, label: "Waiting for connection" } },
    { name: "disconnected voice socket", voice: { ...voice, connected: false },
      expected: { ready: false, label: "Waiting for connection" } },
    { name: "offline voice runtime", voice: { ...voice, live_mode: false },
      expected: { ready: false, label: "Voice calls are offline" } },
    { name: "missing conversation agent", voice: { ...voice, configured: false },
      expected: { ready: false, label: "Conversation agent not configured" } },
    { name: "stale status", stale: true,
      expected: { ready: false, label: "Status unavailable" } },
    { name: "different selected account", clientId: "other",
      expected: { ready: false, label: "Not enabled for this account" } },
    { name: "calling account not present in account status", status: { clients: [] },
      expected: { ready: false, label: "Waiting for connection" } },
  ];
  for (const item of cases) {
    assert.deepEqual(voiceAvailability(item.status || status, item.voice || voice,
      item.clientId || "calling", item.stale || false), item.expected, item.name);
  }
});

/** Observe request deadlines without waiting or leaving real timers running. */
function mockRequest(t, fetchImpl) {
  const scheduled = [], cleared = [];
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    const timer = { callback, milliseconds };
    scheduled.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => { cleared.push(timer); });
  const fetchMock = t.mock.method(globalThis, "fetch", fetchImpl);
  return { scheduled, cleared, fetchMock };
}

for (const action of [false, true]) {
  test(`request ${action ? "actions keep their longer POST budget" : "polls use the short GET budget"}`, async (t) => {
    const payload = { status: "synthetic-result" };
    const body = action ? { clientId: "calling" } : undefined;
    const endpoint = action ? "voice/hangup" : "voice/status";
    const mocks = mockRequest(t, async () => ({ ok: true, json: async () => payload }));
    assert.equal(await request(endpoint, body), payload);
    assert.equal(mocks.fetchMock.mock.callCount(), 1);
    const [url, options] = mocks.fetchMock.mock.calls[0].arguments;
    assert.equal(url, endpoint);
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "same-origin");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.method || "GET", action ? "POST" : "GET");
    assert.deepEqual(options.headers, action ? { "Content-Type": "application/json" } : undefined);
    assert.equal(options.body, action ? JSON.stringify(body) : undefined);
    assert.equal(mocks.scheduled.length, 1);
    assert.equal(mocks.scheduled[0].milliseconds, action ? 90000 : 8000);
    assert.deepEqual(mocks.cleared, mocks.scheduled);
  });

  test(`request ${action ? "action timeouts warn before retry" : "poll timeouts explain connection recovery"}`, async (t) => {
    let signal;
    const mocks = mockRequest(t, (_endpoint, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("Synthetic abort");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    const pending = request(action ? "voice/hangup" : "voice/status",
      action ? { clientId: "calling" } : undefined);
    assert.equal(signal.aborted, false);
    assert.equal(mocks.scheduled[0].milliseconds, action ? 90000 : 8000);
    mocks.scheduled[0].callback();
    assert.equal(signal.aborted, true);
    await assert.rejects(pending, action
      ? /Check the current call or connection status before trying again; the action may still be running/
      : /status request timed out.*Refresh to check the current connection/);
    assert.equal(mocks.fetchMock.mock.callCount(), 1, "Timeouts must never retry an uncertain request");
    assert.deepEqual(mocks.cleared, mocks.scheduled);
  });
}

test("request preserves network failures and clears its deadline without retry", async (t) => {
  const failure = new TypeError("Synthetic network failure");
  const mocks = mockRequest(t, async () => { throw failure; });
  await assert.rejects(request("voice/hangup", { clientId: "calling" }), (error) => error === failure);
  assert.equal(mocks.fetchMock.mock.callCount(), 1);
  assert.equal(mocks.scheduled.length, 1);
  assert.deepEqual(mocks.cleared, mocks.scheduled);
});

test("request preserves JSON parsing failures and clears its deadline", async (t) => {
  const failure = new SyntaxError("Synthetic invalid JSON");
  const mocks = mockRequest(t, async () => ({ ok: true, json: async () => { throw failure; } }));
  await assert.rejects(request("voice/status"), (error) => error === failure);
  assert.equal(mocks.fetchMock.mock.callCount(), 1);
  assert.equal(mocks.scheduled.length, 1);
  assert.deepEqual(mocks.cleared, mocks.scheduled);
});

for (const message of ["Synthetic action failure", null]) {
  test(`request ${message ? "keeps server error messages" : "provides a safe fallback for HTTP failures"}`, async (t) => {
    const mocks = mockRequest(t, async () => ({ ok: false,
      json: async () => message ? { error: { message } } : {} }));
    await assert.rejects(request("voice/hangup", { clientId: "calling" }),
      (error) => error.message === (message || "The request could not complete."));
    assert.equal(mocks.fetchMock.mock.callCount(), 1);
    assert.equal(mocks.scheduled.length, 1);
    assert.deepEqual(mocks.cleared, mocks.scheduled);
  });
}

test("Docker includes the workspace templates and assets", () => {
  const addonRoot = path.resolve(__dirname, "..");
  const dockerfile = fs.readFileSync(path.join(addonRoot, "Dockerfile"), "utf8");
  const dockerignore = fs.readFileSync(path.join(addonRoot, ".dockerignore"), "utf8");
  assert.match(dockerfile, /^COPY\s+(?:\.\/)?webui\/?\s+(?:\.\/|\/app\/base\/)?webui\/?\s*$/m);
  assert.match(dockerignore, /^!webui\/\r?$/m);
  const allowsAll = /^!webui\/\*\*\r?$/m.test(dockerignore);
  for (const extension of ["html", "css", "js"]) {
    assert.ok(allowsAll || new RegExp(`^!webui/\\*\\.${extension}\\r?$`, "m").test(dockerignore),
      `Docker context must include workspace ${extension} files`);
  }
});
