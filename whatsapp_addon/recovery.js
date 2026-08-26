const fs = require("fs");
const path = require("path");

const DEFAULT_RECOVERY_PATH = "/data/decrypt-recovery.json";
const RECOVERY_REASON = "libsignal_decrypt_storm";
const RECOVERY_SCHEMA = 1;
const MAX_SAFE_COUNT = 1_000_000_000;

class RecoveryActionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RecoveryActionError";
    this.status = status;
    this.code = code;
  }
}

const boundedCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_COUNT
    ? value
    : 0;

const validTimestamp = (value) =>
  typeof value === "string" &&
  value.length <= 64 &&
  Number.isFinite(Date.parse(value));

const validRunId = (value) =>
  typeof value === "string" && /^[a-f0-9]{16}$/.test(value);

const sanitizeRecoveryRecord = (value) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== RECOVERY_SCHEMA ||
    value.active !== true ||
    value.reason !== RECOVERY_REASON ||
    !validTimestamp(value.detected_at)
  ) {
    return null;
  }

  return {
    schema: RECOVERY_SCHEMA,
    active: true,
    reason: RECOVERY_REASON,
    detected_at: value.detected_at,
    run_id: validRunId(value.run_id) ? value.run_id : undefined,
    failed_decrypt_messages: boundedCount(value.failed_decrypt_messages),
    bad_mac_session_errors: boundedCount(value.bad_mac_session_errors),
    message_counter_session_errors: boundedCount(
      value.message_counter_session_errors
    ),
  };
};

const createRecoveryRecord = (
  summary,
  { runId, now = () => new Date() } = {}
) =>
  sanitizeRecoveryRecord({
    schema: RECOVERY_SCHEMA,
    active: true,
    reason: RECOVERY_REASON,
    detected_at: now().toISOString(),
    run_id: runId,
    failed_decrypt_messages: boundedCount(summary?.failedDecryptMessages),
    bad_mac_session_errors: boundedCount(summary?.badMacSessionErrors),
    message_counter_session_errors: boundedCount(
      summary?.messageCounterSessionErrors
    ),
  });

const readRecoveryRecord = async ({
  recoveryPath = DEFAULT_RECOVERY_PATH,
  fsPromises = fs.promises,
  logger = console,
} = {}) => {
  try {
    const content = await fsPromises.readFile(recoveryPath, "utf8");
    const record = sanitizeRecoveryRecord(JSON.parse(content));
    if (!record) {
      logger.warn?.("Invalid WhatsApp recovery state was ignored.");
    }
    return record;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger.warn?.("WhatsApp recovery state could not be read.");
    }
    return null;
  }
};

const persistRecoveryRecordSync = ({
  record,
  recoveryPath = DEFAULT_RECOVERY_PATH,
  fsModule = fs,
} = {}) => {
  const safeRecord = sanitizeRecoveryRecord(record);
  if (!safeRecord) {
    throw new TypeError("A valid recovery record is required.");
  }

  const directory = path.dirname(recoveryPath);
  const temporaryPath = `${recoveryPath}.${process.pid}.tmp`;
  fsModule.mkdirSync(directory, { recursive: true });
  try {
    fsModule.writeFileSync(
      temporaryPath,
      `${JSON.stringify(safeRecord)}\n`,
      { mode: 0o600 }
    );
    fsModule.renameSync(temporaryPath, recoveryPath);
  } catch (error) {
    try {
      fsModule.rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup must not replace the original write error.
    }
    throw error;
  }

  return safeRecord;
};

const clearRecoveryRecord = async ({
  recoveryPath = DEFAULT_RECOVERY_PATH,
  fsPromises = fs.promises,
} = {}) => {
  try {
    await fsPromises.unlink(recoveryPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

module.exports = {
  DEFAULT_RECOVERY_PATH,
  RECOVERY_REASON,
  RECOVERY_SCHEMA,
  RecoveryActionError,
  clearRecoveryRecord,
  createRecoveryRecord,
  persistRecoveryRecordSync,
  readRecoveryRecord,
  sanitizeRecoveryRecord,
};
