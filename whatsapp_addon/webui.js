const path = require("path");
const fs = require("node:fs");

const WORKSPACE_ROOT = path.join(__dirname, "webui");
const WORKSPACE_TEMPLATE = fs.readFileSync(path.join(WORKSPACE_ROOT, "workspace.html"), "utf8");

const { RecoveryActionError } = require("./recovery");
const { PairingActionError } = require("./pairing");

const INGRESS_PORT = 8099;
const INGRESS_PROXY_IP = "172.30.32.2";

/** Escape the ingress base before inserting it into the HTML attribute. */
const escapeHtmlAttribute = (value) =>
  String(value).replace(/[&<>"']/g, (char) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[char];
  });

/** Collapse accidental leading slashes before matching ingress routes. */
const normalizeRequestUrl = (url) => (url || "/").replace(/^\/{2,}/, "/");

/** Accept only rooted local ingress prefixes; reject URL schemes and ambiguous separators. */
const normalizeBaseHref = (ingressPath) => {
  if (!ingressPath) return "./";

  const path = String(ingressPath).trim();
  if (!path.startsWith("/") || path.startsWith("//") || /[\\:#?\u0000-\u0020]/.test(path)) return "./";

  return `${path.replace(/\/+$/, "")}/`;
};

/** Normalize IPv4-mapped and bracketed peer addresses for the ingress comparison. */
const normalizeRemoteAddress = (address) =>
  (address || "").replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");

/** Compare the socket peer to the configured Supervisor ingress proxy address. */
const isIngressProxyAddress = (
  address,
  allowedAddress = INGRESS_PROXY_IP
) => normalizeRemoteAddress(address) === allowedAddress;

/** Check the actual peer address without trusting forwarded request headers. */
const isIngressProxyRequest = (req, allowedAddress = INGRESS_PROXY_IP) =>
  isIngressProxyAddress(
    req?.socket?.remoteAddress || req?.connection?.remoteAddress || req?.ip,
    allowedAddress
  );

/** Reject direct network requests before serving workspace data, media controls, or assets. */
const createIngressGuard =
  (allowedAddress = INGRESS_PROXY_IP) =>
  (req, res, next) => {
    if (!isIngressProxyRequest(req, allowedAddress)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }

    next();
  };

/** Return only the connection fields needed by ingress, without session or message content. */
const createStatusSnapshot = ({ clients, clientStates, recovery }) => {
  const ids = [
    ...new Set([
      ...Object.keys(clientStates || {}),
      ...Object.keys(clients || {}),
    ]),
  ].sort();

  return {
    status: recovery?.active ? "recovery_paused" : "ok",
    updatedAt: new Date().toISOString(),
    client_count: ids.length,
    pairing_methods: { qr: true, code: true },
    recovery: {
      active: !!recovery?.active,
      reason: recovery?.active ? recovery.reason : null,
      detectedAt: recovery?.active ? recovery.detectedAt : null,
      failedDecryptMessages: recovery?.active
        ? recovery.failedDecryptMessages || 0
        : 0,
      sessionErrors: recovery?.active
        ? (recovery.badMacSessionErrors || 0) +
          (recovery.messageCounterSessionErrors || 0)
        : 0,
      operationPending: !!recovery?.operationPending,
    },
    clients: ids.map((id) => {
      const state = clientStates[id] || {};
      return {
        id,
        state: state.state || "connecting",
        updatedAt: state.updatedAt || null,
        lastQrAt: state.lastQrAt || null,
        connectedAt: state.connectedAt || null,
        disconnectedAt: state.disconnectedAt || null,
        lastErrorCode: state.lastErrorCode || null,
        qrDataUrl: state.qrDataUrl || null,
        pairingMethod: state.pairingMethod === "phone" ? "phone" : "qr",
        pairingPending: state.pairingPending === true,
        pairingCode: state.pairingCode || null,
      };
    }),
  };
};

/** Read the Supervisor-provided ingress prefix for subsequent validation and rendering. */
const getIngressPath = (req) =>
  req?.get?.("X-Ingress-Path") || req?.get?.("x-ingress-path") || "";

/** Render the shared workspace with an escaped ingress base and an allowlisted initial view. */
const renderWebUi = ({ ingressPath, initialView = "connection" } = {}) => {
  const view = ["connection", "calls", "recordings"].includes(initialView) ? initialView : "connection";
  return WORKSPACE_TEMPLATE
    .replace("{{BASE_HREF}}", () => escapeHtmlAttribute(normalizeBaseHref(ingressPath)))
    .replace("{{INITIAL_VIEW}}", view);
};

/** Serve the shared workspace, status, and guarded recovery actions through ingress. */
const createWebUiApp = ({
  clients,
  clientStates,
  recovery,
  retryRecovery,
  resetRecoveryClient,
  requestPairingCode,
  useQrPairing,
  allowedIngressAddress = INGRESS_PROXY_IP,
}) => {
  const express = require("express");
  const app = express();

  app.disable("x-powered-by");
  app.use(createIngressGuard(allowedIngressAddress));
  app.use((req, res, next) => {
    req.url = normalizeRequestUrl(req.url);
    next();
  });
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "4kb", strict: true }));

  app.get(/\/api\/status$/, (req, res) => {
    res.json(createStatusSnapshot({ clients, clientStates, recovery }));
  });

  /** Require JSON and a non-simple header before changing an account's pairing. */
  const pairingRoute = (action, phone) => (req, res, next) => {
    Promise.resolve().then(async () => {
      if (req.get("x-whatsapp-pairing") !== "1" || req.get("sec-fetch-site") === "cross-site") {
        throw new PairingActionError(403, "pairing_forbidden", "Open the pairing page in Home Assistant and try again.");
      }
      if (!req.is("application/json") || !req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
          Object.keys(req.body).some((key) => !["clientId", ...(phone ? ["phoneNumber"] : [])].includes(key))) {
        throw new PairingActionError(400, "invalid_request", "A JSON pairing request is required.");
      }
      if (typeof action !== "function") throw new PairingActionError(503, "pairing_unavailable", "Pairing controls are unavailable.");
      await action(req.body.clientId, ...(phone ? [req.body.phoneNumber] : []));
      res.json({ status: "pairing_started" });
    }).catch((error) => next(error instanceof PairingActionError ? error
      : new PairingActionError(502, "pairing_failed", "The pairing request failed. Refresh the page and try again.")));
  };
  app.post(/\/api\/pairing\/phone$/, pairingRoute(requestPairingCode, true));
  app.post(/\/api\/pairing\/qr$/, pairingRoute(useQrPairing, false));

  app.post(/\/api\/recovery\/retry$/, (req, res, next) => {
    Promise.resolve()
      .then(async () => {
        if (typeof retryRecovery !== "function") {
          throw new RecoveryActionError(
            503,
            "recovery_unavailable",
            "Recovery controls are unavailable."
          );
        }
        await retryRecovery();
        res.json({ status: "retry_started" });
      })
      .catch(next);
  });

  app.post(/\/api\/recovery\/reset$/, (req, res, next) => {
    Promise.resolve()
      .then(async () => {
        if (typeof resetRecoveryClient !== "function") {
          throw new RecoveryActionError(
            503,
            "recovery_unavailable",
            "Recovery controls are unavailable."
          );
        }
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
          throw new RecoveryActionError(
            400,
            "invalid_request",
            "A JSON request body is required."
          );
        }
        await resetRecoveryClient(req.body.clientId, req.body.confirmation);
        res.json({ status: "pairing_started" });
      })
      .catch(next);
  });

  app.use((error, req, res, next) => {
    if (error instanceof RecoveryActionError || error instanceof PairingActionError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({
        error: {
          code: "invalid_request",
          message: "The JSON request body is invalid.",
        },
      });
      return;
    }
    next(error);
  });

  // Serve only the named local assets, behind the same ingress guard as account status.
  for (const [name, type] of [["workspace.css", "text/css"], ["workspace.js", "text/javascript"]]) {
    app.get(new RegExp("/assets/" + name.replace(".", "\\.") + "$"), (_req, res) => {
      res.type(type).sendFile(path.join(WORKSPACE_ROOT, name));
    });
  }

  app.get(/\/assets\/logo\.png$/, (req, res) => {
    res.sendFile(path.join(__dirname, "logo.png"));
  });

  app.get("*", (req, res) => {
    res.type("html").send(renderWebUi({ ingressPath: getIngressPath(req) }));
  });

  return app;
};

module.exports = {
  INGRESS_PORT,
  createIngressGuard,
  createStatusSnapshot,
  createWebUiApp,
  getIngressPath,
  isIngressProxyAddress,
  isIngressProxyRequest,
  normalizeBaseHref,
  normalizeRequestUrl,
  renderWebUi,
};
