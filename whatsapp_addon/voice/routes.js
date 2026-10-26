"use strict";

const { baseRequire } = require("./base");
const express = baseRequire("express");
const { createApiAuth } = baseRequire("./api");
const { createIngressGuard, normalizeBaseHref } = baseRequire("./webui");
const { userJid } = require("./options");
const escapeHtmlAttribute = value => String(value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));

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

function createVoiceApi(controller, sharedSecret) {
  const router = express.Router();
  router.use(createApiAuth(sharedSecret));
  router.use(voiceRoutes(controller));
  return router;
}

function renderVoiceUi(ingressPath) {
  const base = escapeHtmlAttribute(normalizeBaseHref(ingressPath) + "voice/");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><base href="${base}">
<title>WhatsApp calls</title><style>
body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 20px;background:#101820;color:#edf4f7}
section{padding:24px;border:1px solid #456;border-radius:12px;margin:20px 0}button,input{font:inherit;padding:12px;border-radius:6px}
input{width:90%;margin:12px 0}button{cursor:pointer;margin:8px 8px 8px 0}a{color:#8edbc4}#error{color:#ffb5ab}
audio{display:block;width:100%;margin:12px 0}article{padding:12px 0;border-top:1px solid #456}article p{margin:8px 0}.muted{color:#b8cbd4}
#pairing{border-color:#8edbc4}
</style></head><body><h1>WhatsApp calls</h1>
<p><a href="../">Messaging and pairing</a></p>
<section id="pairing" hidden><h2>Pairing required</h2><p id="pairing-accounts"></p><p><a href="../">Open pairing page</a></p></section>
<section><p id="status">Loading connection state...</p><p id="mode"></p>
<label for="target">WhatsApp user JID</label><input id="target" placeholder="Recipient JID" autocomplete="off">
<button id="call" disabled>Call</button><button id="hangup" disabled>Hang up</button><p id="error" role="status"></p></section>
<p>Voice settings are in this app's Configuration. The existing Home Assistant agent handles home requests.</p>
<section><h2>Call recordings</h2><p id="recording-mode">Loading recording settings...</p>
<p class="muted">Completed recordings include both sides of the call. Change Record calls and Recording retention (days) in Configuration.</p>
<button id="refresh-recordings">Refresh recordings</button><p id="recordings-empty">No completed recordings.</p><div id="recordings"></div></section>
<script>
const statusLine=document.getElementById('status'), mode=document.getElementById('mode'), error=document.getElementById('error');
const showCalls=new URLSearchParams(location.search).get('view')==='calls';
let busy=false;
// Home Assistant opens Ingress here, so send pairing links on to the pairing page.
/** Continue implicit pairing visits once WhatsApp is ready, unless calls were selected explicitly. */
async function refreshPairing(){try{const r=await fetch('../api/status',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();
const waiting=(s.clients||[]).filter(client=>client.state==='pairing').map(client=>client.id);
if(waiting.length&&!showCalls){location.replace('../');return;}
document.getElementById('pairing').hidden=!waiting.length;document.getElementById('pairing-accounts').textContent=waiting.length?'Waiting to be paired: '+waiting.join(', ')+'.':'';}catch{}}
const recordingItems=new Map();
async function refreshRecordings(){try{const r=await fetch('recordings',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();
document.getElementById('recording-mode').textContent=s.last_error||((s.enabled?'Recording is enabled for new calls.':'Recording is off.')+' Completed recordings are kept for '+s.retention_days+' days.');
const container=document.getElementById('recordings'),keep=new Set();
for(const recording of [...s.recordings].reverse()){keep.add(recording.filename);if(recordingItems.has(recording.filename))continue;
const article=document.createElement('article'),title=document.createElement('p'),details=document.createElement('p'),audio=document.createElement('audio'),link=document.createElement('a');
title.textContent=new Date(recording.created_at).toLocaleString();details.className='muted';details.textContent=Math.round(recording.duration_seconds)+' seconds | '+(recording.size_bytes/1048576).toFixed(1)+' MiB | Expires '+new Date(recording.expires_at).toLocaleDateString();
const url='recordings/'+encodeURIComponent(recording.filename);audio.controls=true;audio.preload='none';audio.src=url;link.href=url+'?download=1';link.download=recording.filename;link.textContent='Download recording';
article.append(title,details,audio,link);recordingItems.set(recording.filename,article);container.prepend(article);}
for(const [name,article] of recordingItems){if(!keep.has(name)){article.remove();recordingItems.delete(name);}}
document.getElementById('recordings-empty').hidden=s.recordings.length>0;
}catch{document.getElementById('recording-mode').textContent='Recordings are temporarily unavailable. Voice calls are unaffected.';}}
async function refresh(){try{const r=await fetch('status',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();
statusLine.textContent='Connection: '+s.state;mode.textContent=!s.live_mode?'Offline simulation':s.configured?'Voice calls are configured.':'Select a Home Assistant conversation agent in Configuration to enable calls.';
document.getElementById('call').disabled=busy||!s.live_mode||!s.configured||!s.connected||s.active;document.getElementById('hangup').disabled=busy||!s.active;}catch{statusLine.textContent='Connection unavailable';}}
async function action(name,body){busy=true;error.textContent='';await refresh();try{const r=await fetch(name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error();}catch{error.textContent='The request could not complete. Check app settings and connection.';}finally{busy=false;await refresh();}}
document.getElementById('call').onclick=()=>action('call',{to:document.getElementById('target').value.trim()});
document.getElementById('hangup').onclick=()=>action('hangup',{});document.getElementById('refresh-recordings').onclick=refreshRecordings;
refreshPairing();refresh();refreshRecordings();setInterval(refresh,3000);setInterval(refreshRecordings,5000);setInterval(refreshPairing,5000);
</script></body></html>`;
}

function createVoiceIngress(controller, { allowedIngressAddress } = {}) {
  const router = express.Router();
  router.use(createIngressGuard(allowedIngressAddress));
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", (req, res) => res.type("html").send(renderVoiceUi(req.get("x-ingress-path"))));
  router.use(voiceRoutes(controller));
  return router;
}

module.exports = { createVoiceApi, createVoiceIngress, renderVoiceUi, recordingRange };
