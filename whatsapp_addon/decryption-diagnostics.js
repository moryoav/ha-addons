const crypto = require("node:crypto");

const MAX_DIAGNOSTIC_DEPTH = 24;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 1_000;
const MAX_DIAGNOSTIC_OBJECT_KEYS = 1_000;
const MAX_DIAGNOSTIC_STRING_LENGTH = 128 * 1024;

const isBinaryValue = (value) =>
  Buffer.isBuffer(value) ||
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value);

const toBuffer = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "binary");
  return undefined;
};

const summarizeBinary = (value) => {
  const buffer = toBuffer(value);
  if (!buffer) return undefined;
  return {
    byteLength: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
};

const serializeDiagnosticValue = (
  value,
  { depth = 0, seen = new WeakSet() } = {}
) => {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }

  if (typeof value === "bigint") return value.toString();

  if (typeof value === "string") {
    if (value.length <= MAX_DIAGNOSTIC_STRING_LENGTH) return value;
    return {
      truncatedString: value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH),
      originalLength: value.length,
    };
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }

  if (isBinaryValue(value)) return summarizeBinary(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: serializeDiagnosticValue(value.cause, { depth: depth + 1, seen }),
    };
  }

  if (depth >= MAX_DIAGNOSTIC_DEPTH) return "[maximum depth reached]";
  if (seen.has(value)) return "[circular reference]";
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const result = value
        .slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS)
        .map((item) =>
          serializeDiagnosticValue(item, { depth: depth + 1, seen })
        );
      if (value.length > MAX_DIAGNOSTIC_ARRAY_ITEMS) {
        result.push({ omittedItems: value.length - MAX_DIAGNOSTIC_ARRAY_ITEMS });
      }
      return result;
    }

    if (value instanceof Map) {
      return serializeDiagnosticValue(Object.fromEntries(value), {
        depth: depth + 1,
        seen,
      });
    }

    const result = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS)) {
      result[key] = serializeDiagnosticValue(value[key], {
        depth: depth + 1,
        seen,
      });
    }
    if (keys.length > MAX_DIAGNOSTIC_OBJECT_KEYS) {
      result.omittedKeys = keys.length - MAX_DIAGNOSTIC_OBJECT_KEYS;
    }
    return result;
  } finally {
    seen.delete(value);
  }
};

const rawTimestampIso = (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const serializeBinaryNode = (node, path = "message") => {
  if (!node || typeof node !== "object") {
    return serializeDiagnosticValue(node);
  }

  const result = {
    path,
    tag: node.tag,
    attrs: serializeDiagnosticValue(node.attrs),
  };
  if (Array.isArray(node.content)) {
    result.content = node.content.map((child, index) =>
      child && typeof child === "object" && "tag" in child
        ? serializeBinaryNode(child, `${path}/${child.tag}[${index}]`)
        : serializeDiagnosticValue(child)
    );
  } else if (isBinaryValue(node.content)) {
    result.content = summarizeBinary(node.content);
  } else if (node.content !== undefined) {
    result.content = serializeDiagnosticValue(node.content);
  }
  return result;
};

const collectEncryptedPayloads = (node, path = "message", result = []) => {
  if (!node || typeof node !== "object") return result;
  if (node.tag === "enc") {
    result.push({
      path,
      attrs: serializeDiagnosticValue(node.attrs),
      ...summarizeBinary(node.content),
    });
  }
  if (Array.isArray(node.content)) {
    node.content.forEach((child, index) => {
      if (child && typeof child === "object" && "tag" in child) {
        collectEncryptedPayloads(
          child,
          `${path}/${child.tag}[${index}]`,
          result
        );
      }
    });
  }
  return result;
};

const createRawMessageDiagnostic = (node) => {
  const attrs = node?.attrs || {};
  return {
    source: "raw_message_stanza",
    messageId: attrs.id,
    from: attrs.from,
    participant: attrs.participant,
    recipient: attrs.recipient,
    senderPn: attrs.sender_pn,
    senderLid: attrs.sender_lid,
    participantPn: attrs.participant_pn,
    participantLid: attrs.participant_lid,
    addressingMode: attrs.addressing_mode,
    timestamp: attrs.t,
    timestampIso: rawTimestampIso(attrs.t),
    offline: Object.prototype.hasOwnProperty.call(attrs, "offline"),
    encryptedPayloads: collectEncryptedPayloads(node),
    rawNode: serializeBinaryNode(node),
  };
};

const messageTimestampText = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && typeof value.toString === "function") {
    return value.toString();
  }
  return String(value);
};

const createMessageUpsertDiagnostic = (
  message,
  { type, requestId } = {}
) => {
  const key = message?.key || {};
  const timestamp = messageTimestampText(message?.messageTimestamp);
  const messageTypes = message?.message
    ? Object.keys(message.message).filter((name) => name !== "messageContextInfo")
    : [];
  return {
    source: "messages_upsert",
    upsertType: type,
    requestId,
    messageId: key.id,
    remoteJid: key.remoteJid,
    participant: key.participant,
    fromMe: key.fromMe,
    senderPn: key.senderPn,
    senderLid: key.senderLid,
    participantPn: key.participantPn,
    participantLid: key.participantLid,
    pushName: message?.pushName,
    timestamp,
    timestampIso: rawTimestampIso(timestamp),
    status: message?.status,
    messageStubType: message?.messageStubType,
    messageStubParameters: serializeDiagnosticValue(
      message?.messageStubParameters
    ),
    messageTypes,
    hasDecodedMessage: !!message?.message,
    fullMessage: serializeDiagnosticValue(message),
  };
};

const normalizeLoggerCall = (args) => {
  const [first, second] = args;
  if (typeof first === "string") {
    return {
      message: first,
      details: args.length > 1 ? serializeDiagnosticValue(args.slice(1)) : undefined,
    };
  }
  return {
    message: typeof second === "string" ? second : undefined,
    details: serializeDiagnosticValue(first),
  };
};

const shouldCaptureBaileysLog = (level, message) => {
  if (level === "error" || level === "warn") return true;
  const text = String(message || "").toLowerCase();
  return (
    text.includes("decrypt") ||
    text.includes("cipher") ||
    text.includes("retry") ||
    text.includes("session")
  );
};

const createBaileysDiagnosticLogger = ({ emit, context = {} } = {}) => {
  const write = (level, args) => {
    const { message, details } = normalizeLoggerCall(args);
    if (!shouldCaptureBaileysLog(level, message)) return;
    try {
      emit?.({
        source: "baileys_logger",
        level,
        message,
        context: serializeDiagnosticValue(context),
        details,
      });
    } catch {
      // Diagnostics must never interfere with message processing.
    }
  };

  const diagnosticLogger = {
    level: "info",
    child(childContext = {}) {
      return createBaileysDiagnosticLogger({
        emit,
        context: { ...context, ...childContext },
      });
    },
  };
  for (const level of ["trace", "debug", "info", "warn", "error"]) {
    diagnosticLogger[level] = (...args) => write(level, args);
  }
  return diagnosticLogger;
};

module.exports = {
  collectEncryptedPayloads,
  createBaileysDiagnosticLogger,
  createMessageUpsertDiagnostic,
  createRawMessageDiagnostic,
  serializeDiagnosticValue,
  summarizeBinary,
};
