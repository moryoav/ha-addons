"use strict";

const { baseRequire } = require("./base");
const express = baseRequire("express");
const { createApiAuth } = baseRequire("./api");
const { createIngressGuard, normalizeBaseHref, renderWebUi } = baseRequire("./webui");
const { userJid } = require("./options");

/** Validate a single byte range for seekable WAV responses, returning null for invalid input. */
function recordingRange(header, size) {
  if (!header) return { start:0, end:size - 1, partial:false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  if (match.slice(1).some(part => part && !Number.isSafeInteger(Number(part)))) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size || (!match[1] && Number(match[2]) === 0)) return null;
  return { start, end, partial:true };
}

/** Build voice routes for wrappers that enforce API authentication or the ingress guard. */
function voiceRoutes(controller) {
  const router = express.Router();
  router.use(express.json({ limit:"4kb", strict:true }));
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/status", (_req, res) => res.json(controller.status()));
  router.get("/recordings", (_req, res, next) => {
    void (async () => res.json({ ...(controller.recordings?.status() || { enabled:false, retention_days:30 }),
      recordings:await controller.recordings?.list() || [] }))().catch(next);
  });
  router.get("/recordings/:filename", (req, res, next) => {
    void (async () => {
      const file = await controller.recordings?.open(req.params.filename);
      if (!file) { res.status(404).json({ error:{ code:"recording_unavailable", message:"This recording is unavailable or has expired." } }); return; }
      const size = file.metadata.size_bytes;
      const range = recordingRange(req.get("range"), size);
      if (!range) { await file.handle.close(); res.status(416).set("Content-Range", `bytes */${size}`).end(); return; }
      res.status(range.partial ? 206 : 200).set({ "Content-Type":"audio/wav", "Accept-Ranges":"bytes", "Cache-Control":"no-store",
        "X-Content-Type-Options":"nosniff", "Content-Length":String(range.end - range.start + 1),
        "Content-Disposition":`${req.query.download === "1" ? "attachment" : "inline"}; filename="${file.metadata.filename}"`,
        ...(range.partial ? { "Content-Range":`bytes ${range.start}-${range.end}/${size}` } : {}) });
      if (req.method === "HEAD") { await file.handle.close(); res.end(); return; }
      const stream = file.handle.createReadStream({ start:range.start, end:range.end, autoClose:true });
      res.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    })().catch(next);
  });
  router.post("/call", (req, res, next) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => !["to", "clientId", "message"].includes(key)) || typeof req.body.to !== "string" ||
      (req.body.message !== undefined && (typeof req.body.message !== "string" || !req.body.message.trim() || req.body.message.length > 300))) {
      res.status(400).json({ error:{ code:"invalid_request", message:"Provide one WhatsApp user JID in to." } });
      return;
    }
    if (req.body.clientId !== undefined && req.body.clientId !== controller.options.clientId) {
      res.status(400).json({ error:{ code:"client_not_found", message:"Select the account configured for voice calls." } }); return;
    }
    try { userJid(req.body.to); } catch { res.status(400).json({error:{code:"invalid_request",message:"Provide one WhatsApp user JID."}}); return; }
    void controller.dial(req.body.to, { message:req.body.message }).then(result => res.json(result)).catch(next);
  });
  router.post("/hangup", (req, res, next) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => key !== "clientId")) {
      res.status(400).json({ error:{ code:"invalid_request", message:"Provide only the calling account." } }); return;
    }
    if (req.body.clientId !== undefined && req.body.clientId !== controller.options.clientId) {
      res.status(400).json({ error:{ code:"client_not_found", message:"Select the account configured for voice calls." } }); return;
    }
    void controller.end().then(() => res.json({ status:"ended" })).catch(next);
  });
  router.use((error, _req, res, _next) => {
    const status = error?.type === "entity.parse.failed" || error instanceof TypeError ? 400 : [409, 503].includes(error?.status) ? error.status : 503;
    res.status(status).json({ error:{ code:"voice_unavailable", message:"The voice request could not complete. Check connection and voice settings." } });
  });
  return router;
}

/** Protect controller actions and recordings with the internal API credential. */
function createVoiceApi(controller, sharedSecret) {
  const router = express.Router();
  router.use(createApiAuth(sharedSecret));
  router.use(voiceRoutes(controller));
  return router;
}

/**
 * Render the shared account workspace with its Calls view selected.
 *
 * Kept for callers of the legacy renderer; HTTP entry points redirect to the
 * root workspace so its assets and account controls use one ingress base.
 * @param {string} ingressPath Home Assistant's ingress prefix, if present.
 * @returns {string} The unified workspace HTML.
 */
function renderVoiceUi(ingressPath) {
  return renderWebUi({ ingressPath, initialView:"calls" });
}

/** Return a local workspace URL without trusting an arbitrary redirect header. */
function voiceWorkspaceLocation(req) {
  const base = normalizeBaseHref(req.get("x-ingress-path"));
  // Backslashes can be interpreted as authority separators by browsers. Query,
  // fragment, and control characters cannot belong to an ingress prefix.
  const local = base.startsWith("/") && !base.startsWith("//") && !/[\\?#\u0000-\u0020]/.test(base);
  return `${local ? base : "/"}?view=calls`;
}

/** Guard voice endpoints and redirect legacy page navigation to the shared Calls view. */
function createVoiceIngress(controller, { allowedIngressAddress } = {}) {
  const router = express.Router();
  router.use(createIngressGuard(allowedIngressAddress));
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", (req, res) => res.redirect(302, voiceWorkspaceLocation(req)));
  router.use(voiceRoutes(controller));
  return router;
}

module.exports = { createVoiceApi, createVoiceIngress, renderVoiceUi, recordingRange };
