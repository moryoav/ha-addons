const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  attachServerSyncMonitor,
  createAppStateLogger,
  describeJid,
  summarizeCallLogRecord,
  summarizeSyncAction,
} = require("../app-state-sync");

// Every identifier below is fictional.
const OWN_PN = "999999999999991:4@s.whatsapp.net";
const OWN_LID = "999999999999992:4@lid";
const PEER_LID = "999999999999993@lid";
const PEER_PN = "12025550123@s.whatsapp.net";
const CALL_ID = "0123456789ABCDEF0123456789ABCDEF";
const self = { id: OWN_PN, lid: OWN_LID };
const ref = (value) => `ref:${value.length}`;

const silentLogger = (records = []) => {
  const logger = {
    level: "silent",
    child(bindings) {
      return { ...silentLogger(records), bindings };
    },
  };
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
    logger[level] = (...args) => records.push([level, ...args]);
  }
  return logger;
};

// Encodes and decodes through protobuf so the mutation has the exact shape,
// including Long numbers and enum integers, that Baileys builds from a patch.
const callLogMutation = async (record, index = ["call", PEER_LID, CALL_ID, "1"]) => {
  const { proto } = await import("@whiskeysockets/baileys");
  const data = proto.SyncActionData.fromObject({
    index: Buffer.from(JSON.stringify(index)),
    value: { timestamp: 1790771550000, callLogAction: { callLogRecord: record } },
    version: 2,
  });
  const syncAction = proto.SyncActionData.decode(
    proto.SyncActionData.encode(data).finish()
  );
  return { syncAction, index };
};

test("the installed Baileys reports decoded call-history entries through the logger", async () => {
  const { processSyncAction } = await import("@whiskeysockets/baileys");
  const mutation = await callLogMutation({
    callResult: 0,
    isIncoming: false,
    isVideo: true,
    duration: 42,
    startTime: 1790771550,
    callId: CALL_ID,
    callCreatorJid: OWN_LID,
    callType: 0,
    participants: [{ userJid: PEER_LID, callResult: 0 }],
  });
  const events = [];
  const records = [];
  const logger = createAppStateLogger(silentLogger(records), (event) =>
    events.push(event)
  );
  const ev = new EventEmitter();
  const emitted = [];
  ev.on("chats.update", (update) => emitted.push(update));

  processSyncAction(mutation, ev, self, undefined, logger);

  // Baileys itself ignores the entry; only its logger sees it.
  assert.deepEqual(emitted, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "action");
  assert.equal(events[0].initialSync, false);
  assert.equal(events[0].mutation, mutation);
  assert.ok(records.some(([level, , message]) => level === "trace" &&
    message === "processing sync action"));

  const summary = summarizeSyncAction(events[0].mutation, { ref, self });
  assert.deepEqual(summary, {
    indexType: "call",
    index: [
      "call",
      { kind: "lid", self: false, ref: "ref:19" },
      "value",
      "flag:1",
    ],
    actions: ["callLogAction"],
    callLog: {
      result: "connected",
      isIncoming: false,
      isVideo: true,
      isCallLink: null,
      isDndMode: null,
      callType: "regular",
      silenceReason: null,
      durationSeconds: 42,
      startTime: 1790771550,
      callRef: "ref:32",
      creator: { kind: "lid", self: true, ref: "ref:19" },
      group: null,
      hasCallLinkToken: false,
      hasScheduledCallId: false,
      participantCount: 1,
      participants: [{ kind: "lid", self: false, ref: "ref:19", result: "connected" }],
    },
  });
  const text = JSON.stringify(summary);
  for (const secret of ["999999999999993", "999999999999992", CALL_ID]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test("other app-state changes are summarized by action name only", async () => {
  const { proto } = await import("@whiskeysockets/baileys");
  const syncAction = proto.SyncActionData.decode(
    proto.SyncActionData.encode(
      proto.SyncActionData.fromObject({
        value: { timestamp: 1, archiveChatAction: { archived: true } },
      })
    ).finish()
  );
  assert.deepEqual(
    summarizeSyncAction({ syncAction, index: ["archive", PEER_PN] }, { ref, self }),
    {
      indexType: "archive",
      index: ["archive", { kind: "pn", self: false, ref: "ref:26" }],
      actions: ["archiveChatAction"],
    }
  );
  assert.deepEqual(summarizeSyncAction(undefined), {
    indexType: null,
    index: [],
    actions: [],
  });
});

test("call summaries tolerate missing, unknown and malformed fields", () => {
  assert.deepEqual(summarizeCallLogRecord(null), { malformed: true });
  const summary = summarizeCallLogRecord(
    {
      callResult: 99,
      callType: "VOICE_CHAT",
      silenceReason: 2,
      duration: -1,
      startTime: "not a number",
      callCreatorJid: "not a jid",
      groupJid: "120363000000000000@g.us",
      participants: "none",
    },
    { self }
  );
  assert.equal(summary.result, "unknown");
  assert.equal(summary.callType, "voice_chat");
  assert.equal(summary.silenceReason, "privacy");
  assert.equal(summary.durationSeconds, null);
  assert.equal(summary.startTime, null);
  assert.equal(summary.callRef, null);
  assert.deepEqual(summary.creator, { kind: "unknown" });
  assert.deepEqual(summary.group, { kind: "group", self: false, ref: undefined });
  assert.equal(summary.participantCount, 0);

  assert.equal(describeJid(OWN_PN, { self }).self, true);
  assert.equal(describeJid("999999999999991@s.whatsapp.net", { self }).self, true);
  assert.equal(describeJid(PEER_PN, { self }).self, false);
  assert.equal(describeJid("", { self }), null);
});

test("the logger wrapper reports resync progress and forwards every call", () => {
  const events = [];
  const records = [];
  const inner = silentLogger(records);
  const logger = createAppStateLogger(inner, (event) => events.push(event));

  logger.info("resyncing regular_low from v12");
  logger.info("synced regular_low to v13");
  logger.info("restored state of critical_block from snapshot to v4 with mutations");
  logger.info({ name: "regular_high", error: "stack" }, "failed to sync state from version, removing and trying from scratch");
  logger.info({ name: "Bad Name" }, "failed to sync state from version");
  logger.debug({ unrelated: true }, "sent ack");
  logger.trace({ syncAction: "not an object" }, "processing sync action");

  assert.deepEqual(events, [
    { type: "resync", phase: "started", collection: "regular_low", version: 12 },
    { type: "resync", phase: "synced", collection: "regular_low", version: 13 },
    { type: "resync", phase: "restored", collection: "critical_block", version: 4 },
    { type: "resync", phase: "failed", collection: "regular_high", version: null },
    { type: "resync", phase: "failed", collection: null, version: null },
  ]);
  assert.equal(records.length, 7);

  assert.equal(logger.level, "silent");
  logger.level = "debug";
  assert.equal(inner.level, "debug");

  const child = logger.child({ class: "baileys" });
  child.info("synced regular to v2");
  assert.deepEqual(events.at(-1), {
    type: "resync",
    phase: "synced",
    collection: "regular",
    version: 2,
  });

  const throwing = createAppStateLogger(inner, () => {
    throw new Error("listener failure");
  });
  assert.doesNotThrow(() => throwing.info("synced regular to v3"));
  assert.equal(records.length, 9);
});

test("server_sync notifications report collection names until the socket closes", () => {
  const socket = { ws: new EventEmitter(), ev: new EventEmitter() };
  const reports = [];
  const monitor = attachServerSyncMonitor({
    socket,
    onReport: (report) => reports.push(report),
  });
  const frame = (type, names) => socket.ws.emit("frame", {
    tag: "notification",
    attrs: { type, id: "fictional-id", from: "s.whatsapp.net" },
    content: names.map((name) => ({ tag: "collection", attrs: { name, version: "7" } })),
  });

  frame("server_sync", ["regular_low", "Not Valid", "regular_high"]);
  frame("devices", ["regular"]);
  socket.ws.emit("frame", { tag: "notification", attrs: { type: "server_sync" } });
  socket.ws.emit("frame", new Uint8Array(4));
  assert.deepEqual(reports, [
    { type: "server_sync", collections: ["regular_low", "regular_high"] },
    { type: "server_sync", collections: [] },
  ]);
  assert.doesNotMatch(JSON.stringify(reports), /fictional/);

  socket.ev.emit("connection.update", { connection: "close" });
  frame("server_sync", ["regular"]);
  assert.equal(reports.length, 2);
  assert.equal(socket.ws.listenerCount("frame"), 0);
  monitor.close();

  assert.equal(attachServerSyncMonitor({ socket: {} }), undefined);
});
