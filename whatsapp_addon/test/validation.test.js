const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  RequestValidationError,
  normalizeClientId,
  normalizeConfiguredClientIds,
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
