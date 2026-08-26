const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  RECOVERY_REASON,
  clearRecoveryRecord,
  createRecoveryRecord,
  persistRecoveryRecordSync,
  readRecoveryRecord,
  sanitizeRecoveryRecord,
} = require("../recovery");

const VALID_RECORD = {
  schema: 1,
  active: true,
  reason: RECOVERY_REASON,
  detected_at: "2026-08-26T12:00:00.000Z",
  run_id: "0123456789abcdef",
  failed_decrypt_messages: 77,
  bad_mac_session_errors: 3003,
  message_counter_session_errors: 4,
};

test("recovery records retain only bounded diagnostic counters", () => {
  assert.deepEqual(
    sanitizeRecoveryRecord({
      ...VALID_RECORD,
      private_message: "must not be retained",
      failed_decrypt_messages: -1,
      bad_mac_session_errors: Number.MAX_SAFE_INTEGER,
    }),
    {
      ...VALID_RECORD,
      failed_decrypt_messages: 0,
      bad_mac_session_errors: 0,
    }
  );
  assert.equal(sanitizeRecoveryRecord({ ...VALID_RECORD, active: false }), null);

  assert.deepEqual(
    createRecoveryRecord(
      {
        failedDecryptMessages: 10,
        badMacSessionErrors: 100,
        messageCounterSessionErrors: 2,
      },
      {
        runId: "0123456789abcdef",
        now: () => new Date("2026-08-26T13:00:00.000Z"),
      }
    ),
    {
      ...VALID_RECORD,
      detected_at: "2026-08-26T13:00:00.000Z",
      failed_decrypt_messages: 10,
      bad_mac_session_errors: 100,
      message_counter_session_errors: 2,
    }
  );
});

test("recovery records persist atomically, reload, and clear", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ha-whatsapp-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recoveryPath = path.join(directory, "nested", "recovery.json");

  persistRecoveryRecordSync({ record: VALID_RECORD, recoveryPath });
  const fileMode = fs.statSync(recoveryPath).mode & 0o777;
  if (process.platform !== "win32") assert.equal(fileMode, 0o600);
  assert.deepEqual(await readRecoveryRecord({ recoveryPath }), VALID_RECORD);

  await clearRecoveryRecord({ recoveryPath });
  assert.equal(await readRecoveryRecord({ recoveryPath }), null);
  await clearRecoveryRecord({ recoveryPath });
});
