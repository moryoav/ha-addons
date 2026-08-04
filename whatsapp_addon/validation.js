const path = require("path");

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PHONE_PATTERN = /^\+?([1-9]\d{4,14})$/;
const PHONE_JID_PATTERN = /^([1-9]\d{4,14})@s\.whatsapp\.net$/;

class RequestValidationError extends Error {
  constructor(message = "Invalid request.") {
    super(message);
    this.name = "RequestValidationError";
  }
}

const requirePlainObject = (value, field = "request body") => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError(`${field} must be an object.`);
  }

  return value;
};

const requireString = (
  value,
  field,
  { allowEmpty = false, maxLength = 4096 } = {}
) => {
  if (typeof value !== "string") {
    throw new RequestValidationError(`${field} must be a string.`);
  }

  const normalized = value.trim();
  if (!allowEmpty && !normalized) {
    throw new RequestValidationError(`${field} must not be empty.`);
  }
  if (normalized.length > maxLength) {
    throw new RequestValidationError(`${field} is too long.`);
  }

  return normalized;
};

const normalizeClientId = (value) => {
  if (typeof value !== "string" || !CLIENT_ID_PATTERN.test(value)) {
    throw new RequestValidationError(
      "clientId must start with a letter or digit and contain only letters, digits, underscores, or hyphens (maximum 64 characters)."
    );
  }

  return value;
};

const normalizeConfiguredClientIds = (values) => {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RequestValidationError(
      "clients must be a non-empty array of client IDs."
    );
  }

  const normalized = values.map(normalizeClientId);
  if (new Set(normalized).size !== normalized.length) {
    throw new RequestValidationError("clients must not contain duplicates.");
  }

  return normalized;
};

const resolveSessionPath = (dataRoot, clientId) => {
  const normalizedClientId = normalizeClientId(clientId);
  if (typeof dataRoot !== "string" || !dataRoot) {
    throw new RequestValidationError("The session data root is invalid.");
  }

  const resolvedRoot = path.resolve(dataRoot);
  const resolvedTarget = path.resolve(resolvedRoot, normalizedClientId);
  if (path.dirname(resolvedTarget) !== resolvedRoot) {
    throw new RequestValidationError("The client session path is invalid.");
  }

  return resolvedTarget;
};

const normalizePhoneJid = (value) => {
  const recipient = requireString(value, "to", { maxLength: 64 });
  if (recipient !== value) {
    throw new RequestValidationError("to must not contain surrounding whitespace.");
  }
  const jidMatch = recipient.match(PHONE_JID_PATTERN);
  if (jidMatch) {
    return `${jidMatch[1]}@s.whatsapp.net`;
  }

  const phoneMatch = recipient.match(PHONE_PATTERN);
  if (phoneMatch) {
    return `${phoneMatch[1]}@s.whatsapp.net`;
  }

  throw new RequestValidationError(
    "to must be an international phone number (5-15 digits, optional leading +) or its @s.whatsapp.net JID."
  );
};

module.exports = {
  CLIENT_ID_PATTERN,
  PHONE_JID_PATTERN,
  PHONE_PATTERN,
  RequestValidationError,
  normalizeClientId,
  normalizeConfiguredClientIds,
  normalizePhoneJid,
  requirePlainObject,
  requireString,
  resolveSessionPath,
};
