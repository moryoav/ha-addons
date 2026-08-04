const assert = require("assert");
const { MessageDedupe } = require("../message-dedupe");

const FICTIONAL_PHONE_JID = "12025550123@s.whatsapp.net";
const FICTIONAL_PHONE_JID_ALT = "12025550124@s.whatsapp.net";
const FICTIONAL_PARTICIPANT_JID = "12025550125@s.whatsapp.net";
const SYNTHETIC_LID = "999000111222333@lid";
const SYNTHETIC_LID_ALT = "999000111222334@lid";
const SYNTHETIC_PARTICIPANT_LID = "999000111222335@lid";

let now = 0;

const createDedupe = (ttlMs = 1000) =>
  new MessageDedupe({
    ttlMs,
    maxEntries: 100,
    now: () => now,
  });

const createMessage = ({
  id,
  remoteJid = FICTIONAL_PHONE_JID,
  fromMe = false,
  type = "conversation",
  payload = "hello",
  messageTimestamp = 123,
}) => ({
  key: {
    id,
    remoteJid,
    fromMe,
  },
  messageTimestamp,
  message: {
    [type]: payload,
  },
});

const createImagePayload = ({
  caption = "same caption",
  fileSha256 = Buffer.from("file-sha"),
  fileEncSha256 = Buffer.from("enc-sha"),
  mediaKey = "same-media-key",
  includeThumbnail = false,
  url = "https://mmg.whatsapp.net/a",
  directPath = "/v/t62/a",
  mediaKeyTimestamp = 1700000000,
  scanLengths = [1, 2, 3],
  scansSidecar = Buffer.from("scan-sidecar"),
} = {}) => {
  const payload = {
    caption,
    directPath,
    fileEncSha256,
    fileLength: "12345",
    fileSha256,
    height: 1280,
    mediaKey,
    mediaKeyTimestamp,
    mimetype: "image/jpeg",
    scanLengths,
    scansSidecar,
    url,
    width: 960,
  };

  if (includeThumbnail) {
    payload.jpegThumbnail = Buffer.from("thumbnail");
  }

  return payload;
};

const createQuotedReplyPayload = ({
  participant = SYNTHETIC_PARTICIPANT_LID,
  mentionedJid = [SYNTHETIC_PARTICIPANT_LID],
} = {}) => ({
  text: "Mark as done",
  previewType: "NONE",
  contextInfo: {
    stanzaId: "FICTIONAL_QUOTED_MESSAGE_ID",
    participant,
    mentionedJid,
    quotedMessage: {
      conversation: "same quoted message",
    },
  },
  inviteLinkGroupTypeV2: "DEFAULT",
});

{
  const dedupe = createDedupe();

  assert.strictEqual(
    dedupe.check(
      createMessage({ id: "msg-1", remoteJid: FICTIONAL_PHONE_JID }),
      "conversation"
    ).duplicate,
    false
  );

  now += 10;
  const result = dedupe.check(
    createMessage({ id: "msg-1", remoteJid: SYNTHETIC_LID }),
    "conversation"
  );

  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(result.firstRemoteJid, FICTIONAL_PHONE_JID);
  assert.strictEqual(result.duplicateRemoteJid, SYNTHETIC_LID);
}

{
  const dedupe = createDedupe();

  assert.strictEqual(
    dedupe.check(
      createMessage({
        id: "observed-image-duplicate",
        remoteJid: SYNTHETIC_LID_ALT,
        type: "imageMessage",
        payload: createImagePayload({
          includeThumbnail: true,
          mediaKeyTimestamp: 1700000005,
          url: "https://mmg.whatsapp.net/lid-copy",
          directPath: "/v/t62/lid-copy",
        }),
      }),
      "imageMessage"
    ).duplicate,
    false
  );

  now += 10;
  const result = dedupe.check(
    createMessage({
      id: "observed-image-duplicate",
      remoteJid: FICTIONAL_PHONE_JID_ALT,
      type: "imageMessage",
      payload: createImagePayload({
        includeThumbnail: false,
        mediaKeyTimestamp: { low: 1700000000, high: 0, unsigned: true },
        url: "https://mmg.whatsapp.net/phone-copy",
        directPath: "/v/t62/phone-copy",
        scanLengths: [4, 5, 6],
        scansSidecar: Buffer.from("different-scan-sidecar"),
      }),
    }),
    "imageMessage"
  );

  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(result.collision, false);
  assert.strictEqual(result.firstRemoteJid, SYNTHETIC_LID_ALT);
  assert.strictEqual(result.duplicateRemoteJid, FICTIONAL_PHONE_JID_ALT);
}

{
  const dedupe = createDedupe();

  assert.strictEqual(
    dedupe.check(
      createMessage({
        id: "observed-quoted-reply-duplicate",
        remoteJid: SYNTHETIC_LID,
        type: "extendedTextMessage",
        payload: createQuotedReplyPayload({
          participant: SYNTHETIC_PARTICIPANT_LID,
          mentionedJid: [SYNTHETIC_PARTICIPANT_LID],
        }),
        messageTimestamp: 1700000105,
      }),
      "extendedTextMessage"
    ).duplicate,
    false
  );

  now += 10;
  const result = dedupe.check(
    createMessage({
      id: "observed-quoted-reply-duplicate",
      remoteJid: FICTIONAL_PHONE_JID,
      type: "extendedTextMessage",
      payload: createQuotedReplyPayload({
        participant: FICTIONAL_PARTICIPANT_JID,
        mentionedJid: [FICTIONAL_PARTICIPANT_JID],
      }),
      messageTimestamp: { low: 1700000100, high: 0, unsigned: true },
    }),
    "extendedTextMessage"
  );

  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(result.collision, false);
  assert.strictEqual(result.firstRemoteJid, SYNTHETIC_LID);
  assert.strictEqual(result.duplicateRemoteJid, FICTIONAL_PHONE_JID);
}

{
  const dedupe = createDedupe();

  assert.strictEqual(
    dedupe.check(createMessage({ id: "msg-2" }), "conversation").duplicate,
    false
  );
  assert.strictEqual(
    dedupe.check(createMessage({ id: "msg-3" }), "conversation").duplicate,
    false
  );
}

{
  const dedupe = createDedupe();

  assert.strictEqual(
    dedupe.check(createMessage({ id: "msg-4", payload: "hello" }), "conversation")
      .collision,
    false
  );

  const result = dedupe.check(
    createMessage({ id: "msg-4", payload: "different" }),
    "conversation"
  );

  assert.strictEqual(result.duplicate, false);
  assert.strictEqual(result.collision, true);
}

{
  const dedupe = createDedupe();

  assert.strictEqual(
    dedupe.check(
      createMessage({
        id: "non-media-url-collision",
        type: "customMessage",
        payload: { url: "https://example.invalid/a" },
      }),
      "customMessage"
    ).collision,
    false
  );

  const result = dedupe.check(
    createMessage({
      id: "non-media-url-collision",
      type: "customMessage",
      payload: { url: "https://example.invalid/b" },
    }),
    "customMessage"
  );

  assert.strictEqual(result.duplicate, false);
  assert.strictEqual(result.collision, true);
}

{
  const dedupe = createDedupe();

  assert.strictEqual(
    dedupe.check(
      createMessage({
        id: "image-collision",
        type: "imageMessage",
        payload: createImagePayload({ fileSha256: Buffer.from("file-a") }),
      }),
      "imageMessage"
    ).collision,
    false
  );

  const result = dedupe.check(
    createMessage({
      id: "image-collision",
      type: "imageMessage",
      payload: createImagePayload({ fileSha256: Buffer.from("file-b") }),
    }),
    "imageMessage"
  );

  assert.strictEqual(result.duplicate, false);
  assert.strictEqual(result.collision, true);
}

{
  const dedupe = createDedupe();

  const result = dedupe.check(createMessage({ id: undefined }), "conversation");

  assert.strictEqual(result.duplicate, false);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, "missing_key_id");
}

{
  const dedupe = createDedupe(100);

  now = 0;
  assert.strictEqual(
    dedupe.check(createMessage({ id: "msg-5" }), "conversation").duplicate,
    false
  );

  now = 101;
  assert.strictEqual(
    dedupe.check(createMessage({ id: "msg-5" }), "conversation").duplicate,
    false
  );
}

console.log("message-dedupe tests passed");
