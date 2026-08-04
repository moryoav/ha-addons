const crypto = require("crypto");
const express = require("express");

const {
  WhatsappDisconnectedError,
  WhatsappNumberNotFoundError,
  WhatsappProtocolError,
  WhatsappUpstreamError,
} = require("./whatsapp");
const {
  RequestValidationError,
  normalizeClientId,
  normalizePhoneJid,
  requirePlainObject,
  requireString,
} = require("./validation");

const API_VERSION = 1;
const API_CAPABILITIES = Object.freeze([
  "send_message",
  "set_status",
  "presence_subscribe",
  "send_presence_update",
  "send_infinity_presence_update",
  "read_messages",
  "check_number",
]);
const PRESENCE_TYPES = new Set([
  "available",
  "unavailable",
  "composing",
  "recording",
  "paused",
]);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const hasOwn = (object, property) =>
  Object.prototype.hasOwnProperty.call(object, property);

const createHealthSnapshot = (clients) => ({
  status: "ok",
  service: "ha-whatsapp-addon",
  api_version: API_VERSION,
  capabilities: [...API_CAPABILITIES],
  client_count: Object.keys(clients || {}).length,
});

const safeTokenMatches = (authorization, sharedSecret) => {
  if (typeof authorization !== "string") return false;

  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;

  const supplied = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(sharedSecret);
  return (
    supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected)
  );
};

const createApiAuth = (sharedSecret) => {
  const enabled = typeof sharedSecret === "string" && sharedSecret.trim() !== "";

  return (req, res, next) => {
    if (!enabled || safeTokenMatches(req.get("authorization"), sharedSecret)) {
      next();
      return;
    }

    res.status(401).json({
      error: {
        code: "unauthorized",
        message: "Authentication is required.",
      },
    });
  };
};

const createFixedWindowRateLimiter = ({
  limit = 20,
  windowMs = 60_000,
  now = Date.now,
} = {}) => {
  const buckets = new Map();

  return (key) => {
    const timestamp = now();
    const current = buckets.get(key);

    if (!current || timestamp >= current.resetAt) {
      buckets.set(key, { count: 1, resetAt: timestamp + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((current.resetAt - timestamp) / 1000)
        ),
      };
    }

    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  };
};

const requireClient = (clients, body) => {
  requirePlainObject(body);
  const clientId = normalizeClientId(body.clientId);
  if (!hasOwn(clients, clientId)) {
    throw new ApiError(404, "client_not_found", "The client was not found.");
  }

  return { client: clients[clientId], clientId };
};

const requirePresenceType = (value) => {
  const type = requireString(value, "type", { maxLength: 32 });
  if (!PRESENCE_TYPES.has(type)) {
    throw new RequestValidationError("type is not a supported presence value.");
  }

  return type;
};

const validateOptionalRecipient = (value) => {
  if (value === undefined || value === null) return undefined;
  return requireString(value, "to", { maxLength: 128 });
};

const validateCheckResult = (result, expectedJid) => {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.jid !== expectedJid ||
    typeof result.exists !== "boolean" ||
    (!result.exists && result.lid !== null) ||
    (result.lid !== null &&
      (typeof result.lid !== "string" ||
        !/^[1-9]\d{4,30}@lid$/.test(result.lid)))
  ) {
    throw new WhatsappProtocolError();
  }

  return {
    jid: result.jid,
    exists: result.exists,
    lid: result.lid,
  };
};

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const classifyError = (error) => {
  if (error instanceof ApiError) return error;
  if (error instanceof RequestValidationError) {
    return new ApiError(400, "invalid_request", error.message);
  }
  if (error instanceof WhatsappNumberNotFoundError) {
    return new ApiError(
      404,
      "number_not_found",
      "The phone number is not registered on WhatsApp."
    );
  }
  if (error instanceof WhatsappDisconnectedError) {
    return new ApiError(
      503,
      "client_disconnected",
      "The WhatsApp client is not connected."
    );
  }
  if (
    error instanceof WhatsappProtocolError ||
    error instanceof WhatsappUpstreamError
  ) {
    return new ApiError(
      502,
      "upstream_error",
      "WhatsApp could not complete the request."
    );
  }

  return new ApiError(500, "internal_error", "The request could not be completed.");
};

const safeErrorType = (error) => {
  if (error instanceof ApiError) return "api";
  if (error instanceof RequestValidationError) return "validation";
  if (error instanceof WhatsappNumberNotFoundError) return "number_not_found";
  if (error instanceof WhatsappDisconnectedError) return "disconnected";
  if (error instanceof WhatsappProtocolError) return "protocol";
  if (error instanceof WhatsappUpstreamError) return "upstream";
  return "unexpected";
};

const createApiApp = ({
  clients,
  logger = {},
  sharedSecret,
  lookupRateLimit,
} = {}) => {
  if (!clients || typeof clients !== "object") {
    throw new TypeError("clients is required");
  }

  const checkLookupLimit = createFixedWindowRateLimiter(lookupRateLimit);
  const app = express();

  app.disable("x-powered-by");

  // Keep health public for the container HEALTHCHECK and local monitoring. It
  // deliberately exposes no session identifiers or connection details.
  app.get("/health", (req, res) => {
    res.json(createHealthSnapshot(clients));
  });

  app.use(createApiAuth(sharedSecret));
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.post(
    "/sendMessage",
    asyncRoute(async (req, res) => {
      const body = requirePlainObject(req.body);
      const { client } = requireClient(clients, body);
      const to = requireString(body.to, "to", { maxLength: 128 });
      const message = requirePlainObject(body.body, "body");
      const options =
        body.options === undefined
          ? undefined
          : requirePlainObject(body.options, "options");

      const sentMessage = await client.sendMessage(to, message, options);
      res.json(sentMessage);
    })
  );

  app.post(
    "/setStatus",
    asyncRoute(async (req, res) => {
      const body = requirePlainObject(req.body);
      const { client } = requireClient(clients, body);
      const status = requireString(body.status, "status", { maxLength: 1024 });

      await client.updateProfileStatus(status);
      res.type("text/plain").send("OK");
    })
  );

  app.post(
    "/presenceSubscribe",
    asyncRoute(async (req, res) => {
      const body = requirePlainObject(req.body);
      const { client } = requireClient(clients, body);
      const userId = requireString(body.userId, "userId", { maxLength: 128 });

      await client.presenceSubscribe(userId);
      res.type("text/plain").send("OK");
    })
  );

  app.post(
    "/sendPresenceUpdate",
    asyncRoute(async (req, res) => {
      const body = requirePlainObject(req.body);
      const { client } = requireClient(clients, body);
      const type = requirePresenceType(body.type);
      const to = validateOptionalRecipient(body.to);

      await client.sendPresenceUpdate(type, to);
      res.type("text/plain").send("OK");
    })
  );

  app.post(
    "/readMessages",
    asyncRoute(async (req, res) => {
      const body = requirePlainObject(req.body);
      const { client } = requireClient(clients, body);
      const messageBody = requirePlainObject(body.body, "body");
      const key = requirePlainObject(messageBody.keys, "body.keys");

      await client.readMessages([key]);
      res.type("text/plain").send("OK");
    })
  );

  app.post(
    "/sendInfinityPresenceUpdate",
    asyncRoute(async (req, res) => {
      const body = requirePlainObject(req.body);
      const { client } = requireClient(clients, body);
      const type = requirePresenceType(body.type);
      const to = validateOptionalRecipient(body.to);

      await client.setSendPresenceUpdateInterval(type, to);
      res.type("text/plain").send("OK");
    })
  );

  app.post(
    "/onWhatsApp",
    asyncRoute(async (req, res) => {
      const body = requirePlainObject(req.body);
      const { client, clientId } = requireClient(clients, body);
      const jid = normalizePhoneJid(body.to);
      const limit = checkLookupLimit(clientId);
      if (!limit.allowed) {
        res.set("Retry-After", String(limit.retryAfterSeconds));
        throw new ApiError(
          429,
          "rate_limited",
          "Too many number checks. Try again later."
        );
      }

      const result = await client.checkNumber(jid);
      res.json(validateCheckResult(result, jid));
    })
  );

  app.use((req, res) => {
    res.status(404).json({
      error: { code: "not_found", message: "The API route was not found." },
    });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    let apiError;
    if (error?.type === "entity.parse.failed") {
      apiError = new ApiError(400, "invalid_request", "The request body is invalid JSON.");
    } else if (error?.type === "entity.too.large") {
      apiError = new ApiError(413, "payload_too_large", "The request body is too large.");
    } else {
      apiError = classifyError(error);
    }

    logger.warn?.("WhatsApp API request failed.", {
      status: apiError.status,
      code: apiError.code,
      errorType: safeErrorType(error),
    });
    res.status(apiError.status).json({
      error: { code: apiError.code, message: apiError.message },
    });
  });

  return app;
};

module.exports = {
  API_CAPABILITIES,
  API_VERSION,
  ApiError,
  createApiApp,
  createApiAuth,
  createFixedWindowRateLimiter,
  createHealthSnapshot,
  safeTokenMatches,
  validateCheckResult,
};
