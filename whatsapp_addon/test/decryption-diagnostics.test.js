const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  createBaileysDiagnosticLogger,
  createMessageUpsertDiagnostic,
  createRawMessageDiagnostic,
} = require("../decryption-diagnostics");

const FICTIONAL_JID = "12025550123@s.whatsapp.net";
const FICTIONAL_PARTICIPANT = "12025550124:7@s.whatsapp.net";

test("raw message diagnostics retain stanza identities and ciphertext fingerprints", () => {
  const ciphertext = Buffer.from("fictional encrypted payload");
  const node = {
    tag: "message",
    attrs: {
      id: "fictional-message-id",
      from: FICTIONAL_JID,
      participant: FICTIONAL_PARTICIPANT,
      sender_lid: "999999999999999@lid",
      t: "1788246149",
      offline: "1",
    },
    content: [
      {
        tag: "enc",
        attrs: { type: "msg", v: "2" },
        content: ciphertext,
      },
    ],
  };

  const diagnostic = createRawMessageDiagnostic(node);

  assert.equal(diagnostic.messageId, "fictional-message-id");
  assert.equal(diagnostic.from, FICTIONAL_JID);
  assert.equal(diagnostic.participant, FICTIONAL_PARTICIPANT);
  assert.equal(diagnostic.senderLid, "999999999999999@lid");
  assert.equal(diagnostic.timestampIso, "2026-09-01T07:02:29.000Z");
  assert.equal(diagnostic.offline, true);
  assert.deepEqual(diagnostic.encryptedPayloads, [
    {
      path: "message/enc[0]",
      attrs: { type: "msg", v: "2" },
      byteLength: ciphertext.length,
      sha256: crypto.createHash("sha256").update(ciphertext).digest("hex"),
    },
  ]);
  assert.equal(diagnostic.rawNode.content[0].content.byteLength, ciphertext.length);
});

test("upsert diagnostics retain complete decoded message context", () => {
  const message = {
    key: {
      id: "fictional-message-id",
      remoteJid: FICTIONAL_JID,
      participant: FICTIONAL_PARTICIPANT,
      fromMe: true,
      senderLid: "999999999999999@lid",
    },
    pushName: "Fictional Sender",
    messageTimestamp: 1788246149,
    message: {
      extendedTextMessage: {
        text: "Fictional diagnostic message",
        jpegThumbnail: Buffer.from("thumbnail"),
      },
    },
    status: 2,
  };

  const diagnostic = createMessageUpsertDiagnostic(message, {
    type: "append",
    requestId: "fictional-request-id",
  });

  assert.equal(diagnostic.messageId, "fictional-message-id");
  assert.equal(diagnostic.remoteJid, FICTIONAL_JID);
  assert.equal(diagnostic.participant, FICTIONAL_PARTICIPANT);
  assert.equal(diagnostic.pushName, "Fictional Sender");
  assert.equal(diagnostic.fromMe, true);
  assert.equal(diagnostic.upsertType, "append");
  assert.deepEqual(diagnostic.messageTypes, ["extendedTextMessage"]);
  assert.equal(
    diagnostic.fullMessage.message.extendedTextMessage.text,
    "Fictional diagnostic message"
  );
  assert.equal(
    diagnostic.fullMessage.message.extendedTextMessage.jpegThumbnail.byteLength,
    Buffer.byteLength("thumbnail")
  );
});

test("the diagnostic Baileys logger records decrypt and retry details", () => {
  const entries = [];
  const logger = createBaileysDiagnosticLogger({
    emit: (entry) => entries.push(entry),
    context: { class: "baileys" },
  });

  logger.error(
    {
      key: { id: "fictional-message-id", remoteJid: FICTIONAL_JID },
      err: new Error("No matching sessions found for message"),
    },
    "failed to decrypt message"
  );
  logger.info(
    {
      msgAttrs: { id: "fictional-message-id", from: FICTIONAL_JID },
      retryCount: 3,
    },
    "sent retry receipt"
  );
  logger.info({ ignored: true }, "regular connection information");

  assert.equal(entries.length, 2);
  assert.equal(entries[0].message, "failed to decrypt message");
  assert.equal(entries[0].details.key.id, "fictional-message-id");
  assert.equal(
    entries[0].details.err.message,
    "No matching sessions found for message"
  );
  assert.equal(entries[1].message, "sent retry receipt");
  assert.equal(entries[1].details.retryCount, 3);
});
