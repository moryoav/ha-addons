const assert = require("assert");
const { MessageDedupe } = require("../message-dedupe");

let now = 0;

const createDedupe = (ttlMs = 1000) =>
  new MessageDedupe({
    ttlMs,
    maxEntries: 100,
    now: () => now,
  });

const createMessage = ({
  id,
  remoteJid = "972522241857@s.whatsapp.net",
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
  mediaKeyTimestamp = 1780239123,
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
  participant = "83614691811332@lid",
  mentionedJid = ["83614691811332@lid"],
} = {}) => ({
  text: "Mark as done",
  previewType: "NONE",
  contextInfo: {
    stanzaId: "3EB01A0F21F375F568B95A",
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
      createMessage({ id: "msg-1", remoteJid: "972522241857@s.whatsapp.net" }),
      "conversation"
    ).duplicate,
    false
  );

  now += 10;
  const result = dedupe.check(
    createMessage({ id: "msg-1", remoteJid: "90855889203418@lid" }),
    "conversation"
  );

  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(result.firstRemoteJid, "972522241857@s.whatsapp.net");
  assert.strictEqual(result.duplicateRemoteJid, "90855889203418@lid");
}

{
  const dedupe = createDedupe();

  assert.strictEqual(
    dedupe.check(
      createMessage({
        id: "observed-image-duplicate",
        remoteJid: "237434533077127@lid",
        type: "imageMessage",
        payload: createImagePayload({
          includeThumbnail: true,
          mediaKeyTimestamp: 1780239128,
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
      remoteJid: "972525662800@s.whatsapp.net",
      type: "imageMessage",
      payload: createImagePayload({
        includeThumbnail: false,
        mediaKeyTimestamp: { low: 1780239123, high: 0, unsigned: true },
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
  assert.strictEqual(result.firstRemoteJid, "237434533077127@lid");
  assert.strictEqual(result.duplicateRemoteJid, "972525662800@s.whatsapp.net");
}

{
  const dedupe = createDedupe();

  assert.strictEqual(
    dedupe.check(
      createMessage({
        id: "observed-quoted-reply-duplicate",
        remoteJid: "90855889203418@lid",
        type: "extendedTextMessage",
        payload: createQuotedReplyPayload({
          participant: "83614691811332@lid",
          mentionedJid: ["83614691811332@lid"],
        }),
        messageTimestamp: 1780478259,
      }),
      "extendedTextMessage"
    ).duplicate,
    false
  );

  now += 10;
  const result = dedupe.check(
    createMessage({
      id: "observed-quoted-reply-duplicate",
      remoteJid: "972522241857@s.whatsapp.net",
      type: "extendedTextMessage",
      payload: createQuotedReplyPayload({
        participant: "16823500132@s.whatsapp.net",
        mentionedJid: ["16823500132@s.whatsapp.net"],
      }),
      messageTimestamp: { low: 1780478254, high: 0, unsigned: true },
    }),
    "extendedTextMessage"
  );

  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(result.collision, false);
  assert.strictEqual(result.firstRemoteJid, "90855889203418@lid");
  assert.strictEqual(result.duplicateRemoteJid, "972522241857@s.whatsapp.net");
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
