const assert = require("node:assert/strict");
const test = require("node:test");
const { MessageRetryCache } = require("../message-retry-cache");

let codec;
test.before(async () => {
  codec = (await import("@whiskeysockets/baileys")).proto.Message;
});
const key = {
  id: "fictional-message",
  remoteJid: "999999999999999@lid",
  fromMe: true,
};
const message = (id = key.id, text = "Fictional message") => ({
  key: { ...key, id },
  message: { conversation: text },
});
const makeCache = (t, options = {}) => {
  const cache = new MessageRetryCache({ codec, ...options });
  t.after(() => cache.close());
  return cache;
};

test("protobuf retry messages preserve binary data and 64-bit values without shared mutation", (t) => {
  const cache = makeCache(t);
  const original = {
    key,
    message: codec.fromObject({
      imageMessage: {
        caption: "Fictional image",
        fileLength: "9007199254740993",
        mediaKey: Buffer.from("fictional media bytes"),
      },
      messageContextInfo: {
        messageSecret: Buffer.from("fictional context bytes"),
      },
    }),
  };
  assert.equal(cache.put(original).stored, true);
  original.message.imageMessage.mediaKey.fill(0);
  original.message.imageMessage.caption = "Changed by an event consumer";
  delete original.message.messageContextInfo;
  const first = cache.get(key);
  assert.equal(first.imageMessage.caption, "Fictional image");
  assert.equal(first.imageMessage.mediaKey.toString(), "fictional media bytes");
  assert.equal(first.imageMessage.fileLength.toString(), "9007199254740993");
  assert.equal(
    first.messageContextInfo.messageSecret.toString(),
    "fictional context bytes"
  );
  first.imageMessage.mediaKey.fill(0);
  first.imageMessage.caption = "Changed by retry consumer";
  assert.equal(cache.get(key).imageMessage.caption, "Fictional image");
  assert.equal(
    cache.get(key).imageMessage.mediaKey.toString(),
    "fictional media bytes"
  );
});

test("cache lookups require the exact chat and ID and stay isolated per account", (t) => {
  const cache = makeCache(t);
  const otherAccount = makeCache(t);
  cache.put(message());
  assert.equal(cache.get(key).conversation, "Fictional message");
  for (const changed of [
    { id: "fictional-other" },
    { remoteJid: "12025550123@s.whatsapp.net" },
    { remoteJid: "120363000000000000@g.us" },
    { fromMe: false },
    { fromMe: undefined },
    { remoteJid: undefined },
  ])
    assert.equal(cache.get({ ...key, ...changed }), undefined);
  assert.equal(otherAccount.get(key), undefined);
  const otherChat = {
    ...message(),
    key: { ...key, remoteJid: "12025550123@s.whatsapp.net" },
    message: { conversation: "Different chat" },
  };
  cache.put(otherChat);
  assert.equal(cache.get(otherChat.key).conversation, "Different chat");
  assert.equal(cache.get(key).conversation, "Fictional message");
});

test("replays and retry lookups do not extend the four-hour lifetime", (t) => {
  let now = 0;
  const cache = makeCache(t, { now: () => now });
  cache.put(message());
  now = 175 * 60 * 1000;
  assert.equal(cache.get(key).conversation, "Fictional message");
  assert.equal(
    cache.put(message(key.id, "Changed replay")).reason,
    "already_cached"
  );
  now = 4 * 60 * 60 * 1000;
  assert.equal(cache.get(key), undefined);
  assert.deepEqual(cache.stats, { entries: 0, bytes: 0 });
});

test("entry and byte limits evict oldest messages and reject oversized payloads", (t) => {
  const cache = makeCache(t, { maxEntries: 2 });
  cache.put(message("fictional-1"));
  cache.put(message("fictional-2"));
  assert.equal(cache.put(message("fictional-3")).evicted, 1);
  assert.equal(cache.get({ ...key, id: "fictional-1" }), undefined);
  assert.equal(cache.stats.entries, 2);

  const size = new MessageRetryCache({ codec });
  const oneEntryBytes = size.put(message("fictional-1")).bytes;
  size.close();
  const byteLimited = makeCache(t, { maxBytes: oneEntryBytes + 1 });
  byteLimited.put(message("fictional-1"));
  assert.equal(byteLimited.put(message("fictional-2")).evicted, 1);
  assert.ok(byteLimited.stats.bytes <= oneEntryBytes + 1);
  assert.equal(
    byteLimited.put(message("fictional-big", "x".repeat(1024))).reason,
    "too_large"
  );
  assert.equal(byteLimited.stats.entries, 1);
  const entryLimited = makeCache(t, { maxMessageBytes: 8 });
  assert.equal(entryLimited.put(message()).reason, "too_large");
});

test("failed decrypts and incoming messages cannot poison an existing retry entry", (t) => {
  const cache = makeCache(t);
  cache.put(message());
  for (const invalid of [
    { key, messageStubType: 2 },
    { ...message(key.id, "Partial decode"), messageStubType: 2 },
    { ...message(), key: { ...key, fromMe: false } },
    { ...message(), key: { ...key, id: "" } },
    { ...message(), key: { ...key, remoteJid: "" } },
    null,
  ])
    assert.equal(cache.put(invalid).stored, false);
  assert.equal(cache.get(key).conversation, "Fictional message");
});

test("cache failures fail open and closed caches cannot be repopulated", (t) => {
  const cache = makeCache(t);
  assert.equal(cache.put({ key, message: {} }).reason, "empty");
  const broken = makeCache(t, {
    codec: {
      encode() {
        throw new Error("Fictional failure");
      },
      decode: codec.decode,
    },
  });
  assert.equal(broken.put(message()).reason, "encode_failed");
  const decodeFailure = makeCache(t, {
    codec: {
      encode: codec.encode,
      decode() {
        throw new Error("Fictional failure");
      },
    },
  });
  decodeFailure.put(message());
  assert.equal(decodeFailure.get(key), undefined);
  assert.equal(decodeFailure.stats.entries, 0);
  cache.put(message());
  cache.close();
  assert.equal(cache.get(key), undefined);
  assert.equal(cache.put(message()).reason, "closed");
  assert.deepEqual(cache.stats, { entries: 0, bytes: 0 });
});
