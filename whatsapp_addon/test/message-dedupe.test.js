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
