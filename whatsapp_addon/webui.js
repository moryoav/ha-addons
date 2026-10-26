const path = require("path");

const { RecoveryActionError } = require("./recovery");
const { PairingActionError } = require("./pairing");

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
  if (!path || path.includes("://") || path.startsWith("//")) return "./";

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
        pairingCode: state.state === "pairing" ? state.pairingCode || null : null,
        pairingPending: state.state === "pairing" && state.pairingPending === true,
      };
    }),
  };
};

const getIngressPath = (req) =>
  req?.get?.("X-Ingress-Path") || req?.get?.("x-ingress-path") || "";

const renderWebUi = ({ ingressPath } = {}) => {
  const baseHref = escapeHtmlAttribute(normalizeBaseHref(ingressPath));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <base href="${baseHref}">
  <title>WhatsApp Add-on</title>
  <style>
    :root {
      --page: #f6f7f9;
      --surface: #ffffff;
      --surface-muted: #eef2f4;
      --text: #182026;
      --muted: #687782;
      --line: #dbe2e7;
      --green: #178a52;
      --amber: #a56300;
      --blue: #2563a8;
      --red: #b3261e;
      --shadow: 0 8px 24px rgba(24, 32, 38, 0.08);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --page: #101418;
        --surface: #171d22;
        --surface-muted: #202930;
        --text: #f2f5f7;
        --muted: #a9b5bd;
        --line: #2b363e;
        --shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      }
    }

    * {
      box-sizing: border-box;
    }

    [hidden] { display: none !important; }

    .pairing { width: 280px; max-width: 100%; }
    .pairing p { font-size: 14px; line-height: 1.5; }
    .pairing form { display: grid; gap: 10px; }
    .pairing label { font-size: 14px; font-weight: 600; }
    .pairing input {
      min-height: 44px;
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
    }
    .pairing button { min-height: 44px; }
    .pairing button:focus-visible, .pairing input:focus-visible {
      outline: 2px solid var(--blue);
      outline-offset: 3px;
    }
    .pairing input:disabled { opacity: .65; }
    .pairing-code {
      display: block;
      margin: 14px 0;
      font-family: ui-monospace, monospace;
      font-size: 28px;
      font-weight: 700;
      letter-spacing: .06em;
      user-select: all;
    }
    .pairing-message { color: var(--red); overflow-wrap: anywhere; }
    .pairing-back { margin-top: 12px; }

    body {
      margin: 0;
      min-width: 320px;
      background: var(--page);
      color: var(--text);
      font-family: Inter, Roboto, "Segoe UI", Arial, sans-serif;
      font-size: 16px;
      letter-spacing: 0;
    }

    button {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      padding: 0 14px;
      font: inherit;
      cursor: pointer;
    }

    button:hover {
      border-color: var(--blue);
    }

    button:disabled {
      cursor: wait;
      opacity: 0.6;
    }

    button.danger {
      border-color: var(--red);
      color: var(--red);
    }

    .shell {
      width: min(1080px, 100%);
      margin: 0 auto;
      padding: 24px;
    }

    .topbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
    }

    .topbar-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px 16px;
    }

    .nav-link {
      color: var(--blue);
      font-weight: 600;
    }

    .brand {
      display: grid;
      grid-template-columns: 64px minmax(0, 1fr);
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .brand img {
      width: 64px;
      height: 64px;
      border-radius: 8px;
      object-fit: contain;
      background: var(--surface);
      box-shadow: var(--shadow);
    }

    h1 {
      margin: 0 0 4px;
      font-size: 26px;
      line-height: 1.15;
      font-weight: 700;
    }

    .subtle {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }

    .metric {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-height: 82px;
      box-shadow: var(--shadow);
    }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 8px;
    }

    .metric strong {
      display: block;
      font-size: 20px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .recovery {
      margin-bottom: 18px;
      border: 1px solid var(--red);
      border-radius: 8px;
      padding: 18px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }

    .recovery[hidden] {
      display: none;
    }

    .recovery h2 {
      margin: 0 0 8px;
      font-size: 20px;
    }

    .recovery p {
      margin: 0 0 12px;
      line-height: 1.5;
    }

    .recovery-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .sessions {
      display: grid;
      gap: 12px;
    }

    .session {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: start;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      box-shadow: var(--shadow);
    }

    .session h2 {
      margin: 0 0 10px;
      font-size: 19px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }

    .state {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--surface-muted);
      color: var(--text);
      font-size: 14px;
      line-height: 1.2;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--muted);
      flex: 0 0 auto;
    }

    .state.connected .dot {
      background: var(--green);
    }

    .state.pairing .dot,
    .state.connecting .dot,
    .state.reconnecting .dot,
    .state.restarting .dot {
      background: var(--amber);
    }

    .state.disconnected .dot,
    .state.logged_out .dot,
    .state.recovery_paused .dot {
      background: var(--red);
    }

    .details {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 18px;
      margin-top: 14px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.4;
    }

    .details dt {
      margin: 0;
      font-weight: 600;
      color: var(--text);
    }

    .details dd {
      margin: 2px 0 0;
      overflow-wrap: anywhere;
    }

    .qr {
      width: 216px;
      min-height: 216px;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      overflow: hidden;
    }

    .qr img {
      width: 100%;
      height: auto;
      display: block;
    }

    .qr-empty {
      color: #596772;
      padding: 18px;
      text-align: center;
      line-height: 1.35;
    }

    .empty,
    .error {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      background: var(--surface);
      color: var(--muted);
      box-shadow: var(--shadow);
    }

    .error {
      color: var(--red);
    }

    @media (max-width: 760px) {
      .shell {
        padding: 16px;
      }

      .topbar,
      .session {
        grid-template-columns: 1fr;
      }

      .topbar {
        align-items: stretch;
      }

      .summary {
        grid-template-columns: 1fr;
      }

      .details {
        grid-template-columns: 1fr;
      }

      .qr {
        width: min(100%, 280px);
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <img src="assets/logo.png" alt="WhatsApp Home Assistant logo">
        <div>
          <h1>WhatsApp Add-on</h1>
          <p class="subtle">Session status and pairing</p>
        </div>
      </div>
      <div class="topbar-actions">
        <a class="nav-link" href="voice/?view=calls">WhatsApp calls</a>
        <button type="button" id="refresh">Refresh</button>
      </div>
    </header>

    <section class="summary" aria-label="Bridge summary">
      <div class="metric">
        <span>Bridge</span>
        <strong id="bridge-state">Loading</strong>
      </div>
      <div class="metric">
        <span>Sessions</span>
        <strong id="session-count">0</strong>
      </div>
      <div class="metric">
        <span>Updated</span>
        <strong id="updated-at">-</strong>
      </div>
    </section>

    <section id="recovery" class="recovery" aria-live="polite" hidden>
      <h2>WhatsApp clients paused</h2>
      <p>
        Repeated encryption failures were detected. The add-on stopped its
        WhatsApp clients to protect the host. Retry with the saved session, or
        reset one client and scan a new QR code.
      </p>
      <p id="recovery-details" class="subtle"></p>
      <div id="recovery-actions" class="recovery-actions"></div>
    </section>

    <section id="sessions" class="sessions" aria-label="WhatsApp sessions"></section>
  </main>

  <template id="session-template">
    <article class="session">
      <div>
        <h2 data-client-id></h2>
        <span class="state" data-state>
          <span class="dot" aria-hidden="true"></span>
          <span data-state-label></span>
        </span>
        <dl class="details">
          <div>
            <dt>Last QR</dt>
            <dd data-last-qr>-</dd>
          </div>
          <div>
            <dt>Connected</dt>
            <dd data-connected>-</dd>
          </div>
          <div>
            <dt>Disconnected</dt>
            <dd data-disconnected>-</dd>
          </div>
          <div>
            <dt>Last error</dt>
            <dd data-error>-</dd>
          </div>
        </dl>
      </div>
      <div class="pairing" data-pairing>
        <div class="qr" data-qr></div>
        <p data-qr-help>In WhatsApp, open Linked devices, select Link a device, and scan this QR code.</p>
        <button type="button" data-phone-choice>Link with phone number</button>
        <form data-phone-form hidden>
          <label>Phone number with country code
            <input type="tel" inputmode="tel" autocomplete="off" maxlength="64" required data-phone-number>
          </label>
          <p class="subtle">Use the number signed in to WhatsApp. Include + and your country code.</p>
          <button type="submit" data-generate-code>Generate pairing code</button>
        </form>
        <div data-code-help hidden>
          <output class="pairing-code" aria-label="Pairing code" aria-live="polite" data-pairing-code></output>
          <p>In WhatsApp, open <strong>Linked devices &gt; Link a device &gt; Link with phone number instead</strong>, then enter this code.</p>
          <p class="subtle">If the code is rejected, enter your number again to request a new code. Wait 30 seconds between requests.</p>
        </div>
        <button type="button" class="pairing-back" data-use-qr hidden>Use QR code</button>
        <p class="pairing-message" role="status" aria-live="polite" data-pairing-message></p>
      </div>
    </article>
  </template>

  <script>
    const sessions = document.getElementById("sessions");
    const template = document.getElementById("session-template");
    const bridgeState = document.getElementById("bridge-state");
    const sessionCount = document.getElementById("session-count");
    const updatedAt = document.getElementById("updated-at");
    const refreshButton = document.getElementById("refresh");
    const recoveryPanel = document.getElementById("recovery");
    const recoveryDetails = document.getElementById("recovery-details");
    const recoveryActions = document.getElementById("recovery-actions");
    const sessionItems = new Map();
    let statusRequest = 0;

    /** Update pairing controls without replacing focused fields during polling. */
    const renderPairing = (item, client) => {
      item.clientStatus = client;
      const panel = item.querySelector("[data-pairing]");
      const input = item.querySelector("[data-phone-number]");
      const available = client.state === "pairing";
      const phone = available && (item.dataset.pairingChoice === "phone" || client.pairingMethod === "phone");
      const busy = item.dataset.pairingBusy === "true" || client.pairingPending;
      const qr = item.querySelector("[data-qr]");
      qr.hidden = !!phone;
      item.querySelector("[data-qr-help]").hidden = !available || !!phone;
      item.querySelector("[data-phone-choice]").hidden = !available || !!phone;
      item.querySelector("[data-phone-form]").hidden = !phone;
      item.querySelector("[data-use-qr]").hidden = !phone;
      item.querySelector("[data-code-help]").hidden = !phone || !client.pairingCode;
      item.querySelector("[data-pairing-code]").textContent = available ? client.pairingCode || "" : "";
      panel.setAttribute("aria-busy", String(!!busy));
      panel.querySelectorAll("button, input").forEach((control) => { control.disabled = !!busy; });
      item.querySelector("[data-generate-code]").textContent = busy ? "Generating code..." : "Generate pairing code";
      if (!available) {
        input.value = "";
        delete item.dataset.pairingChoice;
        item.querySelector("[data-pairing-message]").textContent = "";
      }
      qr.replaceChildren();
      if (client.qrDataUrl && available && !phone) {
        const image = document.createElement("img");
        image.src = client.qrDataUrl;
        image.alt = "WhatsApp pairing QR code for " + client.id;
        qr.append(image);
      } else {
        const empty = document.createElement("div");
        empty.className = "qr-empty";
        empty.textContent = client.state === "connected" ? "Paired" : client.state === "recovery_paused" ? "Paused" : "Waiting";
        qr.append(empty);
      }
    };

    /** Send a deliberate pairing action with CSRF protection and an inline error. */
    const postPairingAction = async (item, endpoint, body) => {
      const message = item.querySelector("[data-pairing-message]");
      const controller = new AbortController();
      // Phone codes wait for a fresh WhatsApp handshake before the request itself.
      const timeout = setTimeout(() => controller.abort(), 30000);
      item.dataset.pairingBusy = "true";
      message.textContent = "";
      renderPairing(item, item.clientStatus);
      try {
        const response = await fetch(endpoint, {
          method: "POST", signal: controller.signal,
          headers: { "content-type": "application/json", "x-whatsapp-pairing": "1" },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error?.message || "The pairing request failed. Try again.");
        item.querySelector("[data-phone-number]").value = "";
        if (endpoint.endsWith("/qr")) delete item.dataset.pairingChoice;
      } catch (error) {
        message.textContent = error.name === "AbortError"
          ? "The request timed out. Refresh the page before trying again."
          : error.message || "The pairing request failed. Try again.";
      } finally {
        clearTimeout(timeout);
        delete item.dataset.pairingBusy;
        renderPairing(item, item.clientStatus);
        await loadStatus();
      }
    };

    /** Bind each account's form once so background refreshes preserve typing and focus. */
    const bindPairing = (item, clientId) => {
      item.querySelector("[data-phone-choice]").addEventListener("click", () => {
        item.dataset.pairingChoice = "phone";
        renderPairing(item, item.clientStatus);
        item.querySelector("[data-phone-number]").focus();
      });
      item.querySelector("[data-phone-form]").addEventListener("submit", (event) => {
        event.preventDefault();
        void postPairingAction(item, "api/pairing/phone", {
          clientId, phoneNumber: item.querySelector("[data-phone-number]").value,
        });
      });
      item.querySelector("[data-use-qr]").addEventListener("click", () => {
        if (item.clientStatus.pairingMethod === "phone") {
          void postPairingAction(item, "api/pairing/qr", { clientId });
        } else {
          delete item.dataset.pairingChoice;
          item.querySelector("[data-phone-number]").value = "";
          item.querySelector("[data-pairing-message]").textContent = "";
          renderPairing(item, item.clientStatus);
        }
      });
    };

    const labels = {
      connected: "Connected",
      connecting: "Connecting",
      disconnected: "Disconnected",
      logged_out: "Logged out",
      pairing: "Pairing",
      reconnecting: "Reconnecting",
      recovery_paused: "Paused for recovery",
      restarting: "Restarting",
    };

    const formatDate = (value) => {
      if (!value) return "-";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    };

    const postRecoveryAction = async (endpoint, body) => {
      const buttons = recoveryActions.querySelectorAll("button");
      buttons.forEach((button) => {
        button.disabled = true;
      });
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            payload?.error?.message || "Recovery request failed: " + response.status
          );
        }
        await loadStatus();
      } catch (error) {
        window.alert(error.message || "The recovery request failed.");
        await loadStatus();
      }
    };

    const renderRecovery = (data) => {
      const recovery = data.recovery || {};
      recoveryPanel.hidden = !recovery.active;
      recoveryActions.replaceChildren();
      if (!recovery.active) return;

      const details = [];
      if (recovery.detectedAt) {
        details.push("Detected " + formatDate(recovery.detectedAt));
      }
      if (recovery.failedDecryptMessages) {
        details.push(
          String(recovery.failedDecryptMessages) + " failed messages"
        );
      }
      if (recovery.sessionErrors) {
        details.push(String(recovery.sessionErrors) + " session errors");
      }
      recoveryDetails.textContent = details.join(". ");

      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry connection";
      retry.disabled = !!recovery.operationPending;
      retry.addEventListener("click", () =>
        postRecoveryAction("api/recovery/retry", {})
      );
      recoveryActions.append(retry);

      for (const client of data.clients || []) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "danger";
        reset.textContent = "Reset " + client.id + " and re-pair";
        reset.disabled = !!recovery.operationPending;
        reset.addEventListener("click", () => {
          const confirmation = window.prompt(
            "This deletes the add-on's local pairing for " +
              client.id +
              ". Remove the old add-on entry from WhatsApp Linked Devices, then type the client ID to continue:",
            ""
          );
          if (confirmation === null) return;
          if (confirmation !== client.id) {
            window.alert("The client ID did not match. Nothing was reset.");
            return;
          }
          void postRecoveryAction("api/recovery/reset", {
            clientId: client.id,
            confirmation,
          });
        });
        recoveryActions.append(reset);
      }
    };

    const renderStatus = (data) => {
      bridgeState.textContent = data.status || "unknown";
      sessionCount.textContent = String(data.client_count ?? 0);
      updatedAt.textContent = formatDate(data.updatedAt);
      renderRecovery(data);

      const ids = new Set((data.clients || []).map((client) => client.id));
      for (const [id, item] of sessionItems) {
        if (!ids.has(id)) { item.remove(); sessionItems.delete(id); }
      }
      sessions.querySelectorAll(".empty, .error").forEach((item) => item.remove());

      if (!data.clients || data.clients.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No sessions configured.";
        sessions.append(empty);
        return;
      }

      for (const client of data.clients) {
        let item = sessionItems.get(client.id);
        if (!item) {
          item = template.content.firstElementChild.cloneNode(true);
          sessionItems.set(client.id, item);
          bindPairing(item, client.id);
          sessions.append(item);
        }
        const state = client.state || "connecting";
        item.querySelector("[data-client-id]").textContent = client.id;
        const stateNode = item.querySelector("[data-state]");
        stateNode.className = "state " + state;
        stateNode.querySelector("[data-state-label]").textContent =
          labels[state] || state;
        item.querySelector("[data-last-qr]").textContent =
          formatDate(client.lastQrAt);
        item.querySelector("[data-connected]").textContent =
          formatDate(client.connectedAt);
        item.querySelector("[data-disconnected]").textContent =
          formatDate(client.disconnectedAt);
        item.querySelector("[data-error]").textContent =
          client.lastErrorCode || "-";

        renderPairing(item, client);
      }
    };

    const renderError = (error) => {
      bridgeState.textContent = "error";
      for (const item of sessionItems.values()) {
        renderPairing(item, { ...item.clientStatus, state: "unavailable", qrDataUrl: null, pairingCode: null, pairingPending: false });
      }
      sessions.querySelector(".error")?.remove();
      const message = document.createElement("div");
      message.className = "error";
      message.textContent = error.message || "Unable to load status.";
      sessions.append(message);
    };

    const loadStatus = async () => {
      const request = ++statusRequest;
      try {
        const response = await fetch("api/status", { cache: "no-store" });
        if (!response.ok) throw new Error("Status request failed: " + response.status);
        const data = await response.json();
        if (request === statusRequest) renderStatus(data);
      } catch (error) {
        if (request === statusRequest) renderError(error);
      }
    };

    refreshButton.addEventListener("click", loadStatus);
    loadStatus();
    setInterval(loadStatus, 10000);
  </script>
</body>
</html>`;
};

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

  /** Require JSON and a non-simple request header before changing an account's pairing. */
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
