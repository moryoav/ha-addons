const assert = require("node:assert/strict");
const test = require("node:test");

const { chatReadsFrom, messageStatusesFrom } = require("../receipts");

// Every identifier below is fictional.
const OWN_LID = "999999999999991@lid";
const PEER_LID = "999999999999993@lid";
const MEMBER = "999999999999994@lid";
const GROUP = "120363000000000000@g.us";
const self = { id: "12025550100:4@s.whatsapp.net", lid: "999999999999991:4@lid" };

const update = (fromMe, status, overrides = {}) => ({
  key: { remoteJid: PEER_LID, id: "3EB0AAAAAAAAAAAAAAAAAA", fromMe, ...overrides },
  update: { status },
});
const receipt = (fromMe, receiptFields, overrides = {}) => ({
  key: { remoteJid: GROUP, id: "3EB0BBBBBBBBBBBBBBBBBB", fromMe, participant: MEMBER, ...overrides },
  receipt: { userJid: MEMBER, ...receiptFields },
});

test("direct-chat receipts on sent messages become message statuses", () => {
  const statuses = messageStatusesFrom("messages.update", [
    update(true, 3),
    update(true, 4),
    update(true, 5),
    update(true, 0),
    update(true, 2), // Own devices syncing a sent message: not a recipient status.
    update(true, 1),
    update(false, 4), // Read by this account: a chat read, not a status.
    { key: { remoteJid: PEER_LID, id: "3EB0CC", fromMe: true }, update: { message: {} } },
    update(true, 4, { remoteJid: "status@broadcast" }),
    update(true, 4, { id: "bad id" }),
    null,
  ]);
  assert.deepEqual(statuses.map(({ status }) => status), [
    "delivered",
    "read",
    "played",
    "error",
  ]);
  assert.deepEqual(statuses[1], {
    chatId: PEER_LID,
    messageId: "3EB0AAAAAAAAAAAAAAAAAA",
    status: "read",
    participant: null,
    timestamp: null,
  });
  assert.deepEqual(messageStatusesFrom("messages.update", "not a list"), []);
});

test("group receipts on sent messages name the member and the time", () => {
  const statuses = messageStatusesFrom("message-receipt.update", [
    receipt(true, { receiptTimestamp: 1790840170 }),
    receipt(true, { readTimestamp: 1790840180 }),
    receipt(true, {}),
    receipt(true, { readTimestamp: 1 }, { remoteJid: "status@broadcast" }),
    receipt(false, { readTimestamp: 1790840180 }),
  ]);
  assert.deepEqual(statuses, [
    {
      chatId: GROUP,
      messageId: "3EB0BBBBBBBBBBBBBBBBBB",
      status: "delivered",
      participant: MEMBER,
      timestamp: "2026-10-01T07:36:10.000Z",
    },
    {
      chatId: GROUP,
      messageId: "3EB0BBBBBBBBBBBBBBBBBB",
      status: "read",
      participant: MEMBER,
      timestamp: "2026-10-01T07:36:20.000Z",
    },
  ]);
});

test("messages read or played on another device are grouped per chat", () => {
  const reads = chatReadsFrom("messages.update", [
    update(false, 4, { id: "A1" }),
    update(false, 4, { id: "A2" }),
    update(false, 4, { id: "A2" }),
    update(false, 5, { id: "A3" }),
    update(false, 4, { id: "B1", remoteJid: "12025550123@s.whatsapp.net" }),
    update(false, 3, { id: "C1" }),
    update(true, 4, { id: "D1" }),
    update(false, 4, { id: "E1", remoteJid: "status@broadcast" }),
  ], self);
  assert.deepEqual(reads, [
    { chatId: PEER_LID, status: "read", messageIds: ["A1", "A2"] },
    { chatId: PEER_LID, status: "played", messageIds: ["A3"] },
    { chatId: "12025550123@s.whatsapp.net", status: "read", messageIds: ["B1"] },
  ]);
});

test("group reads count only when this account is the reader", () => {
  const ownRead = (id, userJid) =>
    receipt(false, { readTimestamp: 1790840180 }, { id, participant: userJid });
  const reads = chatReadsFrom("message-receipt.update", [
    { ...ownRead("G1"), receipt: { userJid: OWN_LID, readTimestamp: 1790840180 } },
    { ...ownRead("G2"), receipt: { userJid: "12025550100@s.whatsapp.net", readTimestamp: 1790840180 } },
    { ...ownRead("G3"), receipt: { userJid: MEMBER, readTimestamp: 1790840180 } },
    { ...ownRead("G4"), receipt: { userJid: OWN_LID, receiptTimestamp: 1790840180 } },
  ], self);
  assert.deepEqual(reads, [{ chatId: GROUP, status: "read", messageIds: ["G1", "G2"] }]);
  assert.deepEqual(chatReadsFrom("message-receipt.update", [ownRead("G1", OWN_LID)], {}), []);
});

test("large chat reads are split into events of at most 100 IDs", () => {
  const ids = Array.from({ length: 150 }, (_, index) => `ID${index}`);
  const updates = [...ids, "ID0", "ID149"].map((id) => update(false, 4, { id }));
  const reads = chatReadsFrom("messages.update", updates, self);
  assert.deepEqual(reads.map((read) => read.messageIds.length), [100, 50]);
  assert.ok(reads.every((read) => read.chatId === PEER_LID && read.status === "read"));
  assert.deepEqual(reads.flatMap((read) => read.messageIds), ids);
});
