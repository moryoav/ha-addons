const assert = require("node:assert/strict");
const test = require("node:test");

const { callLogFromHistory, createCallLogTracker } = require("../call-log");

// Every identifier below is fictional.
const OWN_LID = "999999999999991:4@lid";
const OWN_PN = "12025550100:4@s.whatsapp.net";
const PEER_LID = "999999999999993@lid";
const CALL_ID = "0123456789ABCDEF0123456789ABCDEF";
const self = { id: OWN_PN, lid: OWN_LID };

// Encodes and decodes through protobuf, like a patch Baileys has decoded.
const historyMutation = async (record) => {
  const { proto } = await import("@whiskeysockets/baileys");
  const data = proto.SyncActionData.fromObject({
    index: Buffer.from(JSON.stringify(["call_log", OWN_LID, CALL_ID, "0"])),
    value: { timestamp: 1790840199000, callLogAction: { callLogRecord: record } },
    version: 2,
  });
  return {
    index: ["call_log", OWN_LID, CALL_ID, "0"],
    syncAction: proto.SyncActionData.decode(
      proto.SyncActionData.encode(data).finish()
    ),
  };
};

// The shape of a 16 second outgoing voice call seen on a live session.
const outgoingRecord = (overrides = {}) => ({
  callResult: 0,
  isIncoming: false,
  isVideo: false,
  isDndMode: false,
  callType: 0,
  silenceReason: 0,
  duration: 16,
  startTime: 1790840170,
  callId: CALL_ID,
  callCreatorJid: OWN_LID,
  participants: [{ userJid: PEER_LID, callResult: 0 }],
  ...overrides,
});

test("an outgoing call-history entry becomes one call log", async () => {
  const mutation = await historyMutation(outgoingRecord());
  assert.deepEqual(callLogFromHistory(mutation, self), {
    callId: CALL_ID,
    direction: "outgoing",
    result: "connected",
    isVideo: false,
    durationSeconds: 16,
    startedAt: "2026-10-01T07:36:10.000Z",
    peer: PEER_LID,
    participants: [{ jid: PEER_LID, result: "connected" }],
    groupJid: null,
  });

  const tracker = createCallLogTracker();
  assert.equal(tracker.fromCallHistory(mutation, self).callId, CALL_ID);
  assert.equal(tracker.fromCallHistory(mutation, self), undefined);
});

test("the peer is the first participant that is not the linked account", async () => {
  const mutation = await historyMutation(
    outgoingRecord({
      callResult: 4,
      groupJid: "120363000000000000@g.us",
      participants: [
        { userJid: "999999999999991@lid", callResult: 0 },
        { userJid: "not a jid", callResult: 0 },
        { userJid: PEER_LID, callResult: 4 },
      ],
    })
  );
  const callLog = callLogFromHistory(mutation, self);
  assert.equal(callLog.result, "missed");
  assert.equal(callLog.peer, PEER_LID);
  assert.equal(callLog.groupJid, "120363000000000000@g.us");
  assert.deepEqual(callLog.participants, [
    { jid: "999999999999991@lid", result: "connected" },
    { jid: null, result: "connected" },
    { jid: PEER_LID, result: "missed" },
  ]);
});

test("incoming, unfinished and malformed history entries are not reported", async () => {
  for (const overrides of [
    { isIncoming: true },
    { isIncoming: null },
    { callResult: 10 },
    { callResult: 7 },
    { callId: "" },
    { callId: "bad id" },
  ]) {
    const mutation = await historyMutation(outgoingRecord(overrides));
    assert.equal(callLogFromHistory(mutation, self), undefined, JSON.stringify(overrides));
  }
  assert.equal(callLogFromHistory(undefined, self), undefined);
  assert.equal(
    callLogFromHistory({ syncAction: { value: { archiveChatAction: {} } } }, self),
    undefined
  );

  const mutation = await historyMutation(
    outgoingRecord({ duration: null, startTime: null, participants: [] })
  );
  const sparse = callLogFromHistory(mutation, self);
  assert.equal(sparse.durationSeconds, null);
  assert.equal(sparse.startedAt, null);
  assert.equal(sparse.peer, null);
});

const update = (status, overrides = {}) => ({
  callId: CALL_ID,
  status,
  from: PEER_LID,
  chatId: PEER_LID,
  isVideo: status === "offer" ? true : null,
  isGroup: status === "offer" ? false : null,
  groupJid: null,
  date: "2026-10-01T07:40:53.000Z",
  offline: false,
  ...overrides,
});

const run = (tracker, statuses) =>
  statuses.map((status) => tracker.fromCallUpdate(update(status))).filter(Boolean);

test("an incoming call answered on the phone is reported once, when it stops ringing", () => {
  const tracker = createCallLogTracker();
  const logs = run(tracker, ["offer", "ringing", "ringing", "ringing", "accept", "terminate"]);
  assert.deepEqual(logs, [
    {
      callId: CALL_ID,
      direction: "incoming",
      result: "answered",
      isVideo: true,
      durationSeconds: null,
      startedAt: "2026-10-01T07:40:53.000Z",
      peer: PEER_LID,
      participants: [],
      groupJid: null,
    },
  ]);
  // Late or repeated updates for a reported call are ignored.
  assert.deepEqual(run(tracker, ["terminate", "offer", "terminate"]), []);
});

test("incoming calls that are not answered are missed or declined", () => {
  const cases = [
    [["offer", "ringing", "timeout"], "missed"],
    [["offer", "ringing", "terminate"], "missed"],
    [["offer", "reject", "terminate"], "declined"],
    [["offer", "accept", "reject"], "declined"],
    [["offer", "accept", "timeout"], "missed"],
  ];
  for (const [statuses, result] of cases) {
    const logs = run(createCallLogTracker(), statuses);
    assert.equal(logs.length, 1, statuses.join());
    assert.equal(logs[0].result, result, statuses.join());
  }
});

test("a call declined with reject_call is reported as declined", () => {
  const tracker = createCallLogTracker();
  run(tracker, ["offer", "ringing"]);
  tracker.markDeclined(CALL_ID);
  tracker.markDeclined("unknown-call");
  assert.equal(run(tracker, ["terminate"])[0].result, "declined");
});

test("calls without an observed offer or ending are never reported", () => {
  let time = 0;
  const tracker = createCallLogTracker({
    now: () => time,
    pendingTtlMs: 1_000,
    maxPending: 2,
  });
  assert.deepEqual(run(tracker, ["ringing", "accept", "terminate"]), []);
  assert.equal(tracker.fromCallUpdate(update("offer", { callId: null })), undefined);

  tracker.fromCallUpdate(update("offer"));
  time = 1_001;
  assert.equal(tracker.fromCallUpdate(update("terminate")), undefined);

  for (const callId of ["call-1", "call-2", "call-3"]) {
    tracker.fromCallUpdate(update("offer", { callId }));
  }
  assert.equal(tracker.fromCallUpdate(update("terminate", { callId: "call-1" })), undefined);
  assert.equal(tracker.fromCallUpdate(update("terminate", { callId: "call-3" })).result, "missed");
});

test("history and live updates never report the same call twice", async () => {
  const tracker = createCallLogTracker({ maxRemembered: 2 });
  run(tracker, ["offer", "terminate"]);
  const mutation = await historyMutation(outgoingRecord());
  assert.equal(tracker.fromCallHistory(mutation, self), undefined);

  // Old call IDs are forgotten once the memory limit is reached.
  for (const callId of ["call-a", "call-b"]) {
    tracker.fromCallUpdate(update("offer", { callId }));
    tracker.fromCallUpdate(update("timeout", { callId }));
  }
  assert.equal(tracker.fromCallHistory(mutation, self).callId, CALL_ID);
});
