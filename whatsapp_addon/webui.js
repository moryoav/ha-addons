const path = require("path");
const fs = require("node:fs");

const WORKSPACE_ROOT = path.join(__dirname, "webui");
const WORKSPACE_TEMPLATE = fs.readFileSync(path.join(WORKSPACE_ROOT, "workspace.html"), "utf8");

const { RecoveryActionError } = require("./recovery");

const INGRESS_PORT = 8099;
const INGRESS_PROXY_IP = "172.30.32.2";

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

const normalizeRequestUrl = (url) => (url || "/").replace(/^\/{2,}/, "/");

const normalizeBaseHref = (ingressPath) => {
  if (!ingressPath) return "./";

  const path = String(ingressPath).trim();
  if (!path.startsWith("/") || path.startsWith("//") || /[\\:#?\u0000-\u0020]/.test(path)) return "./";

  return `${path.replace(/\/+$/, "")}/`;
};

const normalizeRemoteAddress = (address) =>
  (address || "").replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");

const isIngressProxyAddress = (
  address,
  allowedAddress = INGRESS_PROXY_IP
) => normalizeRemoteAddress(address) === allowedAddress;

const isIngressProxyRequest = (req, allowedAddress = INGRESS_PROXY_IP) =>
  isIngressProxyAddress(
    req?.socket?.remoteAddress || req?.connection?.remoteAddress || req?.ip,
    allowedAddress
  );

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
    pairing_methods: { qr: true, code: false },
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
      };
    }),
  };
};

const getIngressPath = (req) =>
  req?.get?.("X-Ingress-Path") || req?.get?.("x-ingress-path") || "";

/** Render the shared workspace with an escaped ingress base and an allowlisted initial view. */
const renderWebUi = ({ ingressPath, initialView = "connection" } = {}) => {
  const view = ["connection", "calls", "recordings"].includes(initialView) ? initialView : "connection";
  return WORKSPACE_TEMPLATE
    .replace("{{BASE_HREF}}", () => escapeHtmlAttribute(normalizeBaseHref(ingressPath)))
    .replace("{{INITIAL_VIEW}}", view);
};

const createWebUiApp = ({
  clients,
  clientStates,
  recovery,
  retryRecovery,
  resetRecoveryClient,
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
    if (error instanceof RecoveryActionError) {
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
