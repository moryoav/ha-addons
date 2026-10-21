"use strict";

const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const { baseRequire } = require("../base");
const { encodeNode } = require("../wire");
const { parseVoiceOptions } = require("../options");

const SELF = "111111111:3@lid";
const PEER = "222222222@lid";
const PEER_DEVICE = "222222222:7@lid";
const ID = "00000000000000000000000000000001";
const KEY = Buffer.alloc(32, 7);

function testOptions(overrides = {}) {
  const {simulation = false, ...settings} = overrides;
  return parseVoiceOptions({ clients:["default"], voice_agent_id:"conversation.synthetic_agent", allowed_callers:[PEER], automatic_hangup:false, ...settings }, {simulation});
}

const actionNode = (tag, id=ID, creator=SELF, from=PEER_DEVICE) => ({ tag:"call", attrs:{ from }, content:[{ tag, attrs:{ "call-id":id, "call-creator":creator } }] });
const termination = args => ({ tag:"call", attrs:{ to:args.to, id:args.stanza_id }, content:[{ tag:"terminate", attrs:{ "call-id":args.call_id, "call-creator":args.creator, ...(args.reason ? { reason:args.reason } : {}) } }] });

class FakeWorker extends EventEmitter {
  constructor({ native=false } = {}) { super(); this.native=native; this.closed=false; this.ready=Promise.resolve(); this.requests=[]; this.events=[]; }
  async send(event) { this.events.push(structuredClone(event)); }
  async request(action, args={}) {
    this.requests.push({ action, ...structuredClone(args) });
    if (action === "configure") this.events.push({type:"configure", ...structuredClone(args)});
    if (action === "peer") {
      const actionNode=args.node.content.find(child=>["accept","preaccept"].includes(child.tag));
      const cap=actionNode?.content?.find(child=>child.tag==="capability");
      return {audio_supported:true,capability:cap ? (cap.content?.bytes ? "set" : "clear") : "unknown"};
    }
    if (action === "offer") return { node:encodeNode({ tag:"call", attrs:{ to:args.peer_lid, id:args.stanza_id }, content:[{ tag:"offer", attrs:{ "call-id":args.call_id, "call-creator":args.self_lid } }] }) };
    if (action === "terminate") return { node:encodeNode(termination(args)) };
    if (action === "prepare") {
      const offer = args.node.content.find(child => child.tag === "offer");
      const enc = offer.content.find(child => child.tag === "enc");
      const creator=offer.attrs["call-creator"], id=offer.attrs["call-id"], from=args.node.attrs.from;
      return { call_id:id, creator, from, enc_type:enc.attrs.type, ciphertext:enc.content.bytes, version:2,
        receipt:encodeNode({ tag:"receipt", attrs:{ to:from, type:"offer", id:"synthetic-receipt" } }),
        preaccept:encodeNode(actionNode("preaccept",id,creator)), accept:encodeNode(actionNode("accept",id,creator)) };
    }
    if (action === "start") this.emit("event", { type:"call_started", call_id:args.call_id, audio_codec:args.audio_codec, playback_buffer_ms:args.playback_buffer_ms });
    return {};
  }
  close() { if(!this.closed) { this.closed=true; this.emit("failure"); } }
}

async function baileysModule() { return import(pathToFileURL(baseRequire.resolve("@whiskeysockets/baileys")).href); }

function memoryKeys() {
  const values = {};
  return {
    values,
    async get(type, ids) { return Object.fromEntries(ids.filter(id => values[type]?.[id] != null).map(id => [id, values[type][id]])); },
    async set(data) { for(const [type, entries] of Object.entries(data)) Object.assign(values[type] ||= {},entries); },
    async transaction(work) { return work(); },
  };
}

async function signalPair(peerJid=PEER) {
  const baileys = await baileysModule();
  const { makeLibSignalRepository } = await import(new URL("./Signal/libsignal.js", pathToFileURL(baseRequire.resolve("@whiskeysockets/baileys"))).href);
  const create = jid => {
    const creds=baileys.initAuthCreds();
    creds.me={ id:jid.replace(/\d+(?=:3@lid)/,"12025550123").replace("@lid","@s.whatsapp.net"), lid:jid };
    creds.registered=true;
    creds.account={ details:Buffer.from([1]), accountSignature:Buffer.alloc(64,1), accountSignatureKey:Buffer.alloc(32,2), deviceSignature:Buffer.alloc(64,3) };
    const keys=memoryKeys();
    const auth={creds,keys};
    return { auth, repo:makeLibSignalRepository(auth) };
  };
  const host=create(SELF), peer=create(peerJid);
  const prekey=baileys.Curve.generateKeyPair();
  await host.auth.keys.set({ "pre-key":{ "1":prekey } });
  await peer.repo.injectE2ESession({ jid:SELF, session:{ registrationId:host.auth.creds.registrationId,
    identityKey:baileys.generateSignalPubKey(host.auth.creds.signedIdentityKey.public),
    signedPreKey:{ keyId:host.auth.creds.signedPreKey.keyId, publicKey:baileys.generateSignalPubKey(host.auth.creds.signedPreKey.keyPair.public), signature:host.auth.creds.signedPreKey.signature },
    preKey:{ keyId:1, publicKey:baileys.generateSignalPubKey(prekey.public) } } });
  return { baileys, host, peer };
}

function socketHarness({ baileys, host, encrypt, decrypt, query } = {}) {
  const sent=[], queries=[];
  let sequence=0;
  const auth=host?.auth || { creds:{ me:{ id:"12025550123:3@s.whatsapp.net", lid:SELF }, account:{} }, keys:memoryKeys() };
  const socket={ ev:new EventEmitter(), ws:new EventEmitter(), authState:auth,
    signalRepository:host?.repo || { encryptMessage:encrypt || (async () => ({ type:"msg", ciphertext:Buffer.alloc(64,1) })), decryptMessage:decrypt || (async () => Buffer.alloc(0)) },
    processingMutex:{ mutex:async work => work() },
    generateMessageTag:() => "synthetic-"+(++sequence),
    async getUSyncDevices() { return [{ user:"222222222", device:0 }, { user:"222222222", device:7 }]; },
    async assertSessions() {},
    async query(node) { queries.push(node); return query ? query(node) : { tag:"ack", attrs:{ id:node.attrs.id, class:"call", type:"offer" }, content:[] }; },
    async sendNode(node) { sent.push(node); },
    async onWhatsApp() { return [{ exists:true, lid:PEER }]; },
    async getPrivacyTokens() { return { tag:"iq", attrs:{}, content:[] }; },
  };
  const module=baileys || { jidDecode:jid => { const [id,server]=jid.split("@"); const [user,device]=id.split(":"); return { user,server,device:device === undefined ? undefined : +device }; },
    jidEncode:(user,server,device) => user+(device ? ":"+device : "")+"@"+server,
    encodeSignedDeviceIdentity:() => Buffer.from([1,2,3]), encodeWAMessage:() => Buffer.alloc(48,1) };
  return { socket, baileys:module, sent, queries };
}

module.exports={SELF,PEER,PEER_DEVICE,ID,KEY,FakeWorker,testOptions,actionNode,termination,baileysModule,memoryKeys,signalPair,socketHarness};
