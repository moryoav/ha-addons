const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  RequestValidationError,
  normalizeCallId,
  normalizeCallerJid,
  normalizeClientId,
  normalizeConfiguredClientIds,
  normalizeGroupJid,
  normalizePhoneJid,
  resolveSessionPath,
} = require("../validation");

const FICTIONAL_NUMBER = "12025550123";
const FICTIONAL_JID = `${FICTIONAL_NUMBER}@s.whatsapp.net`;

test("client IDs are constrained to safe path components", () => {
  assert.equal(normalizeClientId("default"), "default");
  assert.equal(normalizeClientId("backup_2-test"), "backup_2-test");

  for (const value of [
    "../escape",
    "nested/client",
    "nested\\client",
    ".",
    "_hidden",
    "has space",
    "a".repeat(65),
    "",
    null,
  ]) {
    assert.throws(() => normalizeClientId(value), RequestValidationError);
  }
});

test("configured client IDs must be unique and non-empty", () => {
  assert.deepEqual(normalizeConfiguredClientIds(["default", "backup"]), [
    "default",
    "backup",
  ]);
  assert.throws(() => normalizeConfiguredClientIds([]), RequestValidationError);
  assert.throws(
    () => normalizeConfiguredClientIds(["default", "default"]),
    RequestValidationError
  );
});

test("session paths resolve to one direct child of the data root", () => {
  const root = path.resolve("session-test-root");
  const result = resolveSessionPath(root, "default");

  assert.equal(path.dirname(result), root);
  assert.equal(path.basename(result), "default");
  assert.throws(
    () => resolveSessionPath(root, "../outside"),
    RequestValidationError
  );
});

test("phone lookup accepts only international numbers and phone JIDs", () => {
  assert.equal(normalizePhoneJid(FICTIONAL_NUMBER), FICTIONAL_JID);
  assert.equal(normalizePhoneJid(`+${FICTIONAL_NUMBER}`), FICTIONAL_JID);
  assert.equal(normalizePhoneJid(FICTIONAL_JID), FICTIONAL_JID);

  for (const value of [
    "012025550123",
    "+1 202 555 0123",
    "1202-555-0123",
    "1234",
    "1".repeat(16),
    `${FICTIONAL_NUMBER}:2@s.whatsapp.net`,
    `${FICTIONAL_NUMBER}@lid`,
    "120363000000000000@g.us",
    "status@broadcast",
    `${FICTIONAL_NUMBER}@example.invalid`,
    `  +${FICTIONAL_NUMBER}  `,
    undefined,
  ]) {
    assert.throws(() => normalizePhoneJid(value), RequestValidationError);
  }
});

test("group lookup accepts only @g.us group JIDs", () => {
  const groupJid = "120363000000000000@g.us";
  assert.equal(normalizeGroupJid(groupJid), groupJid);
  assert.equal(
    normalizeGroupJid("12025550123-1600000000@g.us"),
    "12025550123-1600000000@g.us"
  );

  for (const value of [
    "120363000000000000",
    FICTIONAL_JID,
    FICTIONAL_NUMBER,
    `${FICTIONAL_NUMBER}@lid`,
    "status@broadcast",
    "abc@g.us",
    "-12345@g.us",
    "12345-@g.us",
    "12@g.us",
    `${"1".repeat(65)}@g.us`,
    " 120363000000000000@g.us ",
    "",
    undefined,
    null,
  ]) {
    assert.throws(() => normalizeGroupJid(value), RequestValidationError);
  }
});

test("call rejection accepts only call IDs and caller JIDs from call events", () => {
  assert.equal(
    normalizeCallId("0123456789ABCDEF0123456789ABCDEF"),
    "0123456789ABCDEF0123456789ABCDEF"
  );
  assert.equal(normalizeCallId("call-id_1.2:3"), "call-id_1.2:3");
  for (const from of [
    FICTIONAL_JID,
    "999999999999999@lid",
    "999999999999999:7@lid",
    `${FICTIONAL_NUMBER}:3@s.whatsapp.net`,
  ]) {
    assert.equal(normalizeCallerJid(from), from);
  }

  for (const value of ["", " id", "id ", "has space", "-leading", "x".repeat(129), 7, null]) {
    assert.throws(() => normalizeCallId(value), RequestValidationError);
  }
  for (const value of [
    FICTIONAL_NUMBER,
    `+${FICTIONAL_NUMBER}`,
    "120363000000000000@g.us",
    "status@broadcast",
    "0999999999@lid",
    ` ${FICTIONAL_JID}`,
    "999999999999999:12345@lid",
    undefined,
  ]) {
    assert.throws(() => normalizeCallerJid(value), RequestValidationError);
  }
});
