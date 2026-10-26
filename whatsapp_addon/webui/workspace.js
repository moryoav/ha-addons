"use strict";

/** Initialize the browser workspace while keeping its pure helpers usable in Node tests. */
(function workspace() {
  const USER_JID = /^[1-9]\d{4,30}(?::\d{1,5})?@(lid|s\.whatsapp\.net)$/;
  const RECORDING_FILE = /^\d{8}T\d{6}Z-[a-f0-9]{32}\.wav$/;

  /** Normalize a direct-call recipient without accepting groups, URLs, or local-format numbers. */
  function normalizeRecipient(value) {
    if (typeof value !== "string") throw new TypeError("Enter an international phone number or WhatsApp user ID.");
    const input = value.trim();
    if (USER_JID.test(input)) return input;
    if (!/^\+?[1-9][\d ()\-\.]*$/.test(input)) throw new TypeError("Enter an international phone number or WhatsApp user ID.");
    const digits = input.replace(/\D/g, "");
    if (digits.length < 5 || digits.length > 15) throw new TypeError("Use an international phone number with its country code.");
    return digits + "@s.whatsapp.net";
  }

  /** Build a relative protected media URL using only RecordingStore's filename format. */
  function recordingUrl(filename, download = false) {
    if (typeof filename !== "string" || !RECORDING_FILE.test(filename)) throw new TypeError("Invalid recording filename.");
    return "voice/recordings/" + encodeURIComponent(filename) + (download ? "?download=1" : "");
  }

  /** Match both the displayed local date and the ISO date without guessing a timezone. */
  function recordingMatches(recording, query) {
    const search = String(query || "").trim().toLowerCase();
    if (!search) return true;
    const date = new Date(recording?.created_at);
    if (!Number.isFinite(date.getTime())) return false;
    return [date.toISOString(), date.toLocaleString(), date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })].join(" ").toLowerCase().includes(search);
  }

  /** Retain the user's account choice before preferring the configured calling account. */
  function selectAccount(clients, currentId, preferredId) {
    const ids = (clients || []).map(client => client?.id).filter(id => typeof id === "string");
    return ids.includes(currentId) ? currentId : ids.includes(preferredId) ? preferredId : ids[0] || null;
  }

  /** Combine socket and account state so stale voice metadata cannot override recovery. */
  function voiceAvailability(status, voice, clientId, stale = false) {
    if (!voice?.client_id || voice.client_id !== clientId) return { ready: false, label: "Not enabled for this account" };
    const client = status?.clients?.find(item => item.id === clientId);
    if (stale) return { ready: false, label: "Status unavailable" };
    if (status?.recovery?.active || client?.state === "recovery_paused") return { ready: false, label: "Paused for recovery" };
    if (!voice.live_mode) return { ready: false, label: "Voice calls are offline" };
    if (!voice.configured) return { ready: false, label: "Conversation agent not configured" };
    if (!voice.connected || client?.state !== "connected") return { ready: false, label: "Waiting for connection" };
    return { ready: true, label: voice.active ? "Call in progress" : "Ready for calls" };
  }

  /** Bound polls to eight seconds and allow actions time for staged worker startup or shutdown. */
  async function request(endpoint, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), body === undefined ? 8000 : 90000);
    try {
      const response = await fetch(endpoint, { cache: "no-store", credentials: "same-origin", signal: controller.signal,
        ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload?.error?.message === "string" ? payload.error.message : "The request could not complete.");
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(body === undefined
        ? "The status request timed out. Refresh to check the current connection."
        : "The request timed out. Check the current call or connection status before trying again; the action may still be running.");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { normalizeRecipient, recordingMatches, recordingUrl, selectAccount, voiceAvailability, request };
  if (typeof document === "undefined") return;

  const root = document.getElementById("workspace");
  if (!root) return;
  /** Resolve the fixed workspace controls without interpreting account values as selectors. */
  const $ = id => document.getElementById(id);
  const labels = { connected: "Connected", connecting: "Connecting", pairing: "Needs pairing", disconnected: "Disconnected", logged_out: "Logged out", reconnecting: "Reconnecting", restarting: "Restarting", recovery_paused: "Paused for recovery" };
  const viewNames = ["connection", "calls", "recordings"];
  const requestedView = new URLSearchParams(window.location.search).get("view");
  const state = { status: null, voice: null, selected: null, view: viewNames.includes(requestedView) ? requestedView : root.dataset.initialView,
    statusError: false, voiceError: false, recordingsError: false, recordings: [], recordingSettings: null,
    recordingsLoaded: false, busy: false, playing: null, resetClient: null };
  const accountNodes = new Map();
  const recordingNodes = new Map();
  let polling = false, loadingRecordings = false, timer, recordingsTimer;

  // These small, local SVG paths are UI controls, never server-supplied markup.
  const paths = {
    message: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2 1.8-6A8.5 8.5 0 1 1 21 11.5Z"/>',
    phone: '<path d="M6 3H3v3c0 8.3 6.7 15 15 15h3v-3l-5-2-2 2a13 13 0 0 1-8-8l2-2-2-5Z"/>',
    hangup: '<path d="m3 3 18 18M9 4l-1 4m-2 3a16 16 0 0 0 7 7l3-2 5 2v3h-3C10 21 3 14 3 6V3"/>',
    link: '<path d="m10 14 4-4m-6 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2-1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0)"/>',
    recordings: '<path d="M4 9v6m4-9v12m4-15v18m4-15v12m4-9v6"/>',
    settings: '<path d="M3 6h7m4 0h7M3 12h12m4 0h2M3 18h3m4 0h11"/><circle cx="12" cy="6" r="2"/><circle cx="17" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-3l2 3M4 17l2 3a8 8 0 0 0 13-3"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>',
    qr: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h-3zM21 15v6h-6M12 3v3m0 6v3m-9-3h3m6 9v-3m6-6h3"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h1m3 0h1m3 0h1m3 0h1M6 13h1m3 0h1m3 0h1m3 0h1M7 16h10"/>',
  };
  /** Create a decorative icon from the local trusted path set, never from server markup. */
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "wa-icon" })) svg.setAttribute(key, value);
    svg.innerHTML = paths[name] || paths.message;
    return svg;
  }
  root.querySelectorAll("[data-icon]").forEach(node => node.replaceChildren(icon(node.dataset.icon)));
  /** Write status copy as text so account and server values cannot inject markup. */
  function text(id, value) { $(id).textContent = value ?? ""; }
  /** Toggle a region without replacing its controls or native media elements. */
  function show(id, visible) { $(id).hidden = !visible; }
  /** Create workspace markup with optional plain-text content rather than interpolated HTML. */
  function element(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }
  /** Localize valid timestamps and use a neutral fallback for missing or invalid dates. */
  function dateLabel(value) { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : "-"; }
  /** Format recording seconds as non-negative minutes and two-digit seconds. */
  function duration(value) { const seconds = Math.max(0, Math.round(Number(value) || 0)); return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0"); }
  /** Format recording bytes in MiB with a zero fallback for absent numeric metadata. */
  function sizeLabel(value) { return (Math.max(0, Number(value) || 0) / 1048576).toFixed(1) + " MiB"; }
  /** Find the selected account in the latest retained status snapshot. */
  function selectedClient() { return state.status?.clients?.find(client => client.id === state.selected); }
  /** Match the selection to the voice owner independently of current connection readiness. */
  function isCallingAccount() { return !!state.voice?.client_id && state.voice.client_id === state.selected; }
  /** Publish action feedback through the shared workspace status region. */
  function notify(message) { text("feedback", message); show("feedback", true); }
  /** Describe recording mode and retention using library status before the voice fallback. */
  function recordingMode() {
    const recording = state.recordingSettings || state.voice?.recording;
    return recording ? (recording.enabled ? "On" : "Off") + " \u00b7 Kept for " + recording.retention_days + " days" : "Unavailable";
  }

  /** Update account buttons in place so periodic status changes do not steal keyboard focus. */
  function renderAccounts() {
    const clients = state.status?.clients || [];
    const keep = new Set(clients.map(client => client.id));
    for (const [id, node] of accountNodes) if (!keep.has(id)) { node.remove(); accountNodes.delete(id); }
    for (const client of clients) {
      let node = accountNodes.get(client.id);
      if (!node) {
        node = element("button", "wa-account"); node.type = "button";
        const avatar = element("span", "wa-avatar", client.id.slice(0, 1).toUpperCase()); avatar.setAttribute("aria-hidden", "true");
        const copy = element("span", "wa-account-copy"); copy.append(element("span", "wa-account-name", client.id), element("span", "wa-account-status"), element("span", "wa-capability"));
        node.append(avatar, copy); node.addEventListener("click", () => changeAccount(client.id));
        accountNodes.set(client.id, node); $("accounts").append(node);
      }
      node.setAttribute("aria-pressed", String(client.id === state.selected));
      const connected = client.state === "connected";
      const label = labels[client.state] || "Unknown";
      const dot = element("span", "wa-dot" + (connected ? "" : " wa-dot-warning")); dot.setAttribute("aria-hidden", "true");
      node.querySelector(".wa-account-status").replaceChildren(dot, document.createTextNode(label));
      const calling = state.voice?.client_id === client.id;
      node.querySelector(".wa-capability").textContent = calling ? "Messages + calls" : "Messages only";
      node.setAttribute("aria-label", client.id + ", " + label + (calling ? ", messaging and calls" : ", messaging only"));
    }
    text("account-count", clients.filter(client => client.state === "connected").length + " of " + clients.length + " connected");
    show("accounts-empty", !!state.status && clients.length === 0);
  }

  /** Reconcile connection, pairing, and recovery details while removing stale QR data. */
  function renderConnection() {
    const client = selectedClient(), recovery = state.status?.recovery;
    const connected = client?.state === "connected";
    const pairing = !!client && !connected && ["connecting", "pairing", "restarting"].includes(client.state) && !recovery?.active;
    show("connection-summary", !pairing);
    show("pairing", pairing);
    text("connection-title", pairing ? "Connect " + client.id : "Connection");
    text("connection-summary-title", client ? client.id + " is " + (labels[client.state] || "unavailable").toLowerCase() : "No account selected");
    const availability = voiceAvailability(state.status, state.voice, state.selected, state.statusError || state.voiceError);
    text("connection-summary-text", connected ? (availability.ready ? "Messages and voice calls are ready." : isCallingAccount() ? "Messages are ready. Voice calls: " + availability.label.toLowerCase() + "." : "Messages are ready. Configure voice calling in the add-on settings if needed.") : "Check the account state and add-on logs. Saved pairings are preserved during automatic reconnection.");
    const qr = client?.qrDataUrl;
    const validQr = pairing && !state.statusError && typeof qr === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qr);
    show("pairing-qr", validQr); show("pairing-placeholder", !validQr);
    if (validQr) { if ($("pairing-qr").getAttribute("src") !== qr) $("pairing-qr").src = qr; }
    else $("pairing-qr").removeAttribute("src");
    text("pairing-status", validQr ? "Waiting for scan" : "Waiting for a QR code...");
    text("pairing-placeholder", state.statusError ? "Connection status is unavailable. Refresh to check for a current QR code." : "A QR code will appear here when WhatsApp is ready for pairing.");
    text("messaging-state", connected ? "Ready" : labels[client?.state] || "Unavailable");
    text("connection-voice", availability.label);
    text("connected-at", dateLabel(client?.connectedAt)); text("checked-at", dateLabel(state.status?.updatedAt));
    text("last-qr-at", dateLabel(client?.lastQrAt)); text("last-error", client?.lastErrorCode || "-");
    show("connection-details", !!client && !pairing); show("connection-shortcuts", !!client && isCallingAccount());
    show("reset-actions", !!client && !!recovery?.active);
    $("reset-account").disabled = state.busy || !!recovery?.operationPending;
  }

  /** Keep the call owner actionable globally and gate selected-account controls by readiness. */
  function renderCalling() {
    const voice = state.voice, owner = voice?.client_id;
    const own = isCallingAccount();
    const active = !!voice?.active;
    show("active-call", active);
    text("active-call-title", (voice?.state === "calling" ? "Calling" : voice?.state === "ending" ? "Ending call" : "In call") + " \u00b7 " + (owner || "Calling account"));
    text("active-call-detail", state.voiceError ? "Call status is unavailable. You can still request hang-up." : (voice?.direction === "incoming" ? "Incoming call" : "Outgoing call") + (voice?.recording?.active ? " \u00b7 Recording on" : ""));
    $("global-hangup").disabled = state.busy;
    show("calling-controls", own); show("calls-unavailable", !own);
    text("calls-unavailable-title", owner ? "Calling is not enabled for this account" : "Voice calling is not configured");
    text("calls-unavailable-text", owner ? "The calling account is " + owner + ". This account can still use Home Assistant messaging actions." : state.voiceError ? "Voice status is unavailable. Refresh the page or check the add-on logs." : "Select a calling account and a Home Assistant conversation agent in the add-on Configuration.");
    show("go-calling-account", !!owner && !!state.status?.clients?.some(client => client.id === owner));
    const availability = voiceAvailability(state.status, voice, state.selected, state.statusError || state.voiceError);
    const ready = availability.ready;
    text("voice-ready", availability.label);
    text("agent-state", voice?.configured ? "Home Assistant agent" : "Not configured"); text("recording-mode", recordingMode());
    text("call-source", owner ? "From " + owner : "");
    $("call").disabled = !ready || active || state.busy; show("call", !active);
    show("call-hangup", active && own); $("call-hangup").disabled = state.busy;
    $("recipient").disabled = active || state.busy; $("opening-message").disabled = active || state.busy;
    text("settings-caller", owner || "Not selected"); text("settings-agent", voice?.configured ? "Configured in Home Assistant" : "Not configured");
    text("settings-recording", (state.recordingSettings || voice?.recording)?.enabled ? "On" : "Off");
    const retention = (state.recordingSettings || voice?.recording)?.retention_days;
    text("settings-retention", retention ? retention + " days" : "Unavailable");
    show("recent-recordings", own);
  }

  /** Reconcile snapshots and task visibility without recreating inputs or native players. */
  function render() {
    const clients = state.status?.clients || [];
    state.selected = selectAccount(clients, state.selected, state.voice?.client_id);
    renderAccounts(); renderConnection(); renderCalling(); renderRecent();
    const client = selectedClient();
    text("account-title", state.selected || "WhatsApp accounts");
    text("account-subtitle", state.selected ? (isCallingAccount() ? "Messaging and voice calls" : "Messaging account") : "Select an account to get started.");
    show("account-state", !!client);
    const badge = $("account-state"); badge.classList.toggle("wa-status-warning", client?.state !== "connected");
    const dot = element("span", "wa-dot" + (client?.state === "connected" ? "" : " wa-dot-warning")); dot.setAttribute("aria-hidden", "true");
    badge.replaceChildren(dot, document.createTextNode(labels[client?.state] || "Unknown"));
    text("updated-at", state.statusError ? "Account status unavailable" : state.status ? "Updated " + dateLabel(state.status.updatedAt) : "Loading account status...");
    show("status-error", state.statusError); text("status-error", "Connection status is unavailable. Refresh to reconnect. Call controls remain available for a known active call.");
    const recovery = state.status?.recovery;
    show("recovery", !!recovery?.active);
    text("recovery-details", [recovery?.detectedAt ? "Detected " + dateLabel(recovery.detectedAt) : "", recovery?.failedDecryptMessages ? recovery.failedDecryptMessages + " failed messages" : "", recovery?.sessionErrors ? recovery.sessionErrors + " session errors" : ""].filter(Boolean).join(". "));
    $("recovery-retry").disabled = state.busy || !!recovery?.operationPending;
    viewNames.forEach(view => show(view + "-panel", view === state.view));
    root.querySelectorAll(".wa-tabs [data-view]").forEach(button => { if (button.dataset.view === state.view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
    renderRecordings();
    if ($("reset-dialog").open) updateResetConfirmation();
  }

  /** Change account context and pause recording audio from the previous selection. */
  function changeAccount(id) { if (state.selected !== id) pauseAudio(); state.selected = id; render(); }
  /** Select a known task, update its local URL, and refresh the library when entering it. */
  function changeView(view) {
    if (!viewNames.includes(view)) return;
    if (view !== "recordings") pauseAudio();
    state.view = view; show("feedback", false); render();
    const url = new URL(window.location.href); url.searchParams.set("view", view); window.history.replaceState(null, "", url);
    if (view === "recordings") void refreshRecordings();
  }

  /** Never rebuild media nodes on a poll: doing so interrupts playback and resets seeking. */
  function createRecording(recording) {
    const article = element("article", "wa-recording");
    const row = element("div", "wa-recording-row");
    const play = element("button", "wa-play"); play.type = "button"; play.append(icon("play"));
    const name = element("div", "wa-recording-name");
    const title = element("div", "wa-recording-title"), detail = element("div", "wa-recording-date"); name.append(title, detail);
    const length = element("span", "wa-recording-length"), size = element("span", "wa-recording-size");
    const download = element("a", "wa-icon-button wa-recording-download"); download.href = recordingUrl(recording.filename, true); download.download = recording.filename; download.append(icon("download"));
    row.append(play, name, length, size, download);
    const player = element("div", "wa-recording-player"); player.hidden = true;
    const audio = element("audio", "wa-audio"); audio.controls = true; audio.preload = "none"; audio.src = recordingUrl(recording.filename);
    const expiry = element("p", "wa-recording-expiry"); player.append(audio, expiry); article.append(row, player);
    play.addEventListener("click", () => { if (!audio.paused) audio.pause(); else playRecording(recording.filename); });
    audio.addEventListener("play", () => { for (const item of recordingNodes.values()) if (item.audio !== audio) item.audio.pause(); state.playing = recording.filename; player.hidden = false; play.replaceChildren(icon("pause")); play.setAttribute("aria-label", "Pause recording from " + dateLabel(recording.created_at)); });
    audio.addEventListener("pause", () => { if (state.playing === recording.filename) state.playing = null; play.replaceChildren(icon("play")); play.setAttribute("aria-label", "Play recording from " + dateLabel(recording.created_at)); renderRecordings(); });
    audio.addEventListener("ended", () => { state.playing = null; renderRecordings(); });
    audio.addEventListener("error", () => { if (state.playing === recording.filename) state.playing = null; notify("This recording is unavailable or has expired. Refresh the recording list."); renderRecordings(); });
    return { article, play, title, detail, length, size, download, player, audio, expiry };
  }
  /** Pause cached players without discarding their native playback and seeking state. */
  function pauseAudio() { for (const item of recordingNodes.values()) item.audio.pause(); }
  /** Expand a cached player and release the active-filter exemption if playback fails. */
  function playRecording(filename) {
    const item = recordingNodes.get(filename); if (!item) return;
    item.player.hidden = false; state.playing = filename;
    void item.audio.play().catch(() => { if (state.playing === filename) state.playing = null; notify("The recording could not play. Try its download link or refresh the list."); renderRecordings(); });
  }
  /** Reconcile filename-keyed rows, expiry details, and date filtering without resetting audio. */
  function renderRecordings() {
    const filter = $("recording-search").value;
    const keep = new Set(state.recordings.map(recording => recording.filename));
    for (const [filename, item] of recordingNodes) if (!keep.has(filename)) { item.audio.pause(); item.article.remove(); recordingNodes.delete(filename); if (state.playing === filename) { state.playing = null; notify("The playing recording is no longer available. It may have expired."); } }
    let matching = 0;
    state.recordings.forEach((recording, index) => {
      let item = recordingNodes.get(recording.filename);
      if (!item) { item = createRecording(recording); recordingNodes.set(recording.filename, item); $("recording-list").insertBefore(item.article, $("recording-list").children[index] || null); }
      item.title.textContent = dateLabel(recording.created_at); item.detail.textContent = "WAV";
      item.length.textContent = duration(recording.duration_seconds); item.size.textContent = sizeLabel(recording.size_bytes);
      item.expiry.textContent = "Expires " + dateLabel(recording.expires_at);
      item.download.setAttribute("aria-label", "Download recording from " + dateLabel(recording.created_at));
      if (item.audio.paused) item.play.setAttribute("aria-label", "Play recording from " + dateLabel(recording.created_at));
      item.audio.setAttribute("aria-label", "Recording from " + dateLabel(recording.created_at));
      const match = recordingMatches(recording, filter); if (match) matching++;
      item.article.hidden = !match && state.playing !== recording.filename;
    });
    text("recordings-subtitle", "Completed calls" + (state.recordingSettings?.retention_days ? " \u00b7 Kept for " + state.recordingSettings.retention_days + " days" : ""));
    show("recordings-error", state.recordingsError); text("recordings-error", "Recordings are temporarily unavailable. Voice calls are unaffected. Refresh to try again.");
    const recordingError = state.recordingSettings?.last_error;
    show("recordings-notice", !!recordingError || state.recordingSettings?.enabled === false);
    text("recordings-notice", recordingError || "Recording is off for new calls. Existing recordings stay available until they expire.");
    text("recordings-empty", !state.recordingsLoaded ? "Loading recordings..." : state.recordings.length === 0 ? "No completed recordings. New recordings appear here after a recorded call ends." : "No recordings match this date. Try another search.");
    show("recordings-empty", !state.recordingsError && (!state.recordingsLoaded || matching === 0) && !state.playing);
  }
  /** Rebuild recent-recording shortcuts only when their source metadata changes. */
  function renderRecent() {
    const container = $("recent-recording-list");
    const signature = JSON.stringify(state.recordings.slice(0, 3));
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature; container.replaceChildren();
    for (const recording of state.recordings.slice(0, 3)) {
      const row = element("div", "wa-recording-row"), button = element("button", "wa-play"); button.type = "button"; button.append(icon("play")); button.setAttribute("aria-label", "Play recording from " + dateLabel(recording.created_at));
      const label = element("div", "wa-recording-name", dateLabel(recording.created_at));
      const length = element("span", "wa-recording-length", duration(recording.duration_seconds));
      button.addEventListener("click", () => { changeView("recordings"); playRecording(recording.filename); }); row.append(button, label, length); container.append(row);
    }
  }

  /** Fetch account and voice status independently, retaining last-known snapshots on failure. */
  async function refreshStatus() {
    if (polling) return;
    polling = true;
    try {
      const results = await Promise.allSettled([request("api/status"), request("voice/status")]);
      if (results[0].status === "fulfilled" && Array.isArray(results[0].value.clients)) { state.status = results[0].value; state.statusError = false; } else state.statusError = true;
      if (results[1].status === "fulfilled" && typeof results[1].value.active === "boolean") { state.voice = results[1].value; state.voiceError = false; } else state.voiceError = true;
      render();
    } finally { polling = false; }
  }
  /** Refresh file metadata without dropping the library or players on temporary failures. */
  async function refreshRecordings() {
    if (loadingRecordings) return;
    loadingRecordings = true;
    try {
      const payload = await request("voice/recordings");
      if (!Array.isArray(payload.recordings)) throw new Error("Recordings unavailable.");
      state.recordings = payload.recordings.filter(item => item && typeof item.filename === "string" && RECORDING_FILE.test(item.filename));
      state.recordingSettings = payload; state.recordingsLoaded = true; state.recordingsError = false;
    } catch { state.recordingsError = true; }
    finally { loadingRecordings = false; renderRecordings(); renderRecent(); renderCalling(); }
  }

  /** An uncertain action is followed by status polling, never an automatic duplicate request. */
  async function action(endpoint, body, success) {
    if (state.busy) return false;
    state.busy = true; render();
    try { await request(endpoint, body); if (success) notify(success); return true; }
    catch (error) { notify(error.message || "The request could not complete. Check the account connection."); return false; }
    finally { state.busy = false; await refreshStatus(); render(); }
  }

  root.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button || button.disabled) return;
    if (button.dataset.view) changeView(button.dataset.view);
    if (button.dataset.action === "settings") show("settings", $("settings").hidden);
  });
  $("refresh").addEventListener("click", () => { void refreshStatus(); void refreshRecordings(); });
  $("refresh-pairing").addEventListener("click", () => { void refreshStatus(); });
  $("refresh-recordings").addEventListener("click", () => { void refreshRecordings(); });
  $("recording-search").addEventListener("input", renderRecordings);
  $("go-calling-account").addEventListener("click", () => { changeAccount(state.voice.client_id); });
  $("call-form").addEventListener("submit", event => {
    event.preventDefault(); if ($("call").disabled) return;
    let to;
    try {
      to = normalizeRecipient($("recipient").value);
    } catch (error) {
      $("recipient").setAttribute("aria-invalid", "true"); text("call-error", error.message); show("call-error", true); $("recipient").focus();
      return;
    }
    $("recipient").removeAttribute("aria-invalid");
    const opening = $("opening-message").value.trim();
    const body = { clientId: state.selected, to, ...(opening ? { message: opening } : {}) };
    show("call-error", false); void action("voice/call", body, "Call requested. The live call status appears above.");
  });
  /** Request hang-up only for a known active call and its configured owning account. */
  const hangup = () => { if (state.voice?.active) void action("voice/hangup", { clientId: state.voice.client_id }, "Hang-up requested."); };
  $("global-hangup").addEventListener("click", hangup); $("call-hangup").addEventListener("click", hangup);
  $("recovery-retry").addEventListener("click", () => { if (state.status?.recovery?.active) void action("api/recovery/retry", {}, "Connection retry started with saved sessions."); });
  $("reset-account").addEventListener("click", () => {
    if (!state.status?.recovery?.active || !state.selected) return;
    state.resetClient = state.selected; text("reset-name", state.resetClient); text("reset-id", state.resetClient); $("reset-confirmation").value = "";
    $("confirm-reset").disabled = true; show("reset-error", false); $("reset-dialog").showModal();
  });
  /** Keep exact-ID confirmation retryable after failure while respecting recovery and busy state. */
  function updateResetConfirmation() {
    $("confirm-reset").disabled = $("reset-confirmation").value !== state.resetClient || state.busy || !state.status?.recovery?.active || !!state.status.recovery.operationPending;
  }
  $("reset-confirmation").addEventListener("input", updateResetConfirmation);
  $("cancel-reset").addEventListener("click", () => $("reset-dialog").close());
  $("reset-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!state.status?.recovery?.active || $("reset-confirmation").value !== state.resetClient || state.busy) return;
    $("confirm-reset").disabled = true;
    const ok = await action("api/recovery/reset", { clientId: state.resetClient, confirmation: $("reset-confirmation").value }, "Account reset. Scan its new QR code when it appears.");
    if (ok) $("reset-dialog").close();
    else {
      text("reset-error", "The account could not be reset. Check recovery status and try again."); show("reset-error", true);
      updateResetConfirmation();
    }
  });

  /** Schedule non-overlapping account polls while skipping requests in a hidden document. */
  function schedule() { clearTimeout(timer); timer = setTimeout(async () => { if (!document.hidden) await refreshStatus(); schedule(); }, 3000); }
  /** Poll saved recordings only while a visible Calls or Recordings view needs them. */
  function scheduleRecordings() { clearTimeout(recordingsTimer); recordingsTimer = setTimeout(async () => { if (!document.hidden && ["calls", "recordings"].includes(state.view)) await refreshRecordings(); scheduleRecordings(); }, 10000); }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { void refreshStatus(); void refreshRecordings(); } });
  render(); void refreshStatus(); void refreshRecordings(); schedule(); scheduleRecordings();
})();
