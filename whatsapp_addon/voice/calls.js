"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { JsonProcess, childEnvironment } = require("./process");
const { encodeNode, decodeNode, decodeBytes } = require("./wire");
const { userJid, sameUser } = require("./options");
const GREETINGS = require("./greetings.json");

const ACTIONS = new Set(["offer", "accept", "reject", "terminate", "preaccept", "transport", "relaylatency"]);

function callInfo(node) {
  if (node?.tag !== "call" || !Array.isArray(node.content)) return null;
  const action = node.content.find(child => ACTIONS.has(child?.tag));
  const id = action?.attrs?.["call-id"];
  const creator = action?.attrs?.["call-creator"];
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || typeof creator !== "string") return null;
  const from = node.attrs?.participant || node.attrs?.from || creator;
  return { action: action.tag, id, creator, from, child: action };
}

function sameDevice(first, second) {
  return sameUser(first, second) && (first.match(/:(\d+)@/)?.[1] || "0") === (second.match(/:(\d+)@/)?.[1] || "0");
}

function terminateNode(call, to, stanzaId) {
  // Exact direct-audio shape from wacore::stanza::call::build_terminate.
  // Teardown must still work when the native process has failed or is connecting.
  return { tag:"call", attrs:{ to, id:stanzaId }, content:[{ tag:"terminate", attrs:{ "call-id":call.id, "call-creator":call.creator } }] };
}

function selfIdentity(socket, baileys) {
  const me = socket.authState?.creds?.me;
  if (!me?.id || !me.lid) throw new Error("linked_device_identity_unavailable");
  const own = baileys.jidDecode(me.id);
  const lid = baileys.jidDecode(me.lid);
  if (!own || !lid || lid.server !== "lid") throw new Error("linked_device_identity_unavailable");
  return baileys.jidEncode(lid.user, "lid", lid.device ?? own.device ?? 0);
}

class CallController {
  constructor(options, {
    workerFactory = () => new JsonProcess("/usr/local/bin/whatsapp-call-worker", ["--allow-network"], { env: childEnvironment() }),
    bridgeFactory = () => new JsonProcess("python3", ["-u", path.join(__dirname, "bridge/bridge.py"), "--allow-network"], { env: childEnvironment(process.env, true) }),
    logger = {}, recordings = null, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  } = {}) {
    this.options = options;
    this.workerFactory = workerFactory;
    this.bridgeFactory = bridgeFactory;
    this.logger = logger;
    this.recordings = recordings;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.socket = null;
    this.baileys = null;
    this.connected = false;
    this.active = null;
    this.endTask = null;
    this.generation = 0;
    this.listeners = [];
    this.lastError = null;
    this.lastGreeting = null;
    this.privacy = new Map();
  }

  attach(socket, baileys) {
    this.detach();
    this.socket = socket;
    this.baileys = baileys;
    const generation = ++this.generation;
    const connection = update => {
      if (this.generation !== generation) return;
      this.connected = update.connection === "open" || (this.connected && update.connection !== "close");
      if (update.connection === "close") void this.end(false, "disconnected");
    };
    const raw = node => {
      if (this.generation !== generation || !this.connected || !this.options.live) return;
      // Preserve binary content now; other observers must never share mutable worker objects.
      const observed = this.active;
      try { void this.incoming(decodeNode(encodeNode(node))).catch(() => {
        if (observed && this.active === observed) this.failed(observed);
        else this.lastError = "incoming_call_failed";
      }); }
      catch { this.lastError = "invalid_call_signaling"; }
    };
    const privacy = node => this.capturePrivacy(node);
    socket.ev.on("connection.update", connection);
    socket.ws.on("CB:call", raw);
    socket.ws.on("CB:notification,type:privacy_token", privacy);
    this.listeners = [() => socket.ev.off("connection.update", connection), () => socket.ws.off("CB:call", raw), () => socket.ws.off("CB:notification,type:privacy_token", privacy)];
  }

  detach() {
    this.connected = false;
    for (const remove of this.listeners) remove();
    this.listeners = [];
    // Close old workers immediately before a reconnect can attach a new socket.
    const call = this.active;
    if (call) {
      this.active = null;
      this.clearTimeout(call.timer);
      call.closed = true;
      call.worker?.close();
      call.bridge?.close();
      if (call.recordingStarted) this.recordings?.failed();
      this.recordings?.release(call.recordingFilename);
    }
    this.socket = null;
    this.baileys = null;
  }

  capturePrivacy(node) {
    const visit = (part, depth = 0) => {
      if (!part || depth > 8) return;
      const jid = part.attrs?.jid || node.attrs?.from;
      if (part.tag === "token" && typeof jid === "string" && part.content instanceof Uint8Array && part.content.length <= 8192) {
        this.privacy.set(jid.replace(/:\d+@/, "@"), Buffer.from(part.content));
        while (this.privacy.size > 64) this.privacy.delete(this.privacy.keys().next().value);
      }
      if (Array.isArray(part.content)) part.content.forEach(child => visit(child, depth + 1));
    };
    visit(node);
  }

  check(call) {
    if (this.active !== call || call.closed || call.generation !== this.generation || !this.connected) throw new Error("stale_call");
  }

  reserve(id, peer, creator, direction) {
    if (!this.options.live) throw Object.assign(new Error("Calling is disabled during offline simulation."), { status: 409 });
    if (!this.options.clientId || !this.options.bridge.agent_id) throw Object.assign(new Error("Select a calling account and Home Assistant conversation agent before calling."), { status: 409 });
    if (!this.connected || !this.socket) throw Object.assign(new Error("WhatsApp is not connected."), { status: 503 });
    if (this.active || this.endTask) throw Object.assign(new Error("Another call is active."), { status: 409 });
    const own = selfIdentity(this.socket, this.baileys);
    this.lastError = null;
    const call = { id, peer, creator: creator || own, own, direction, generation: this.generation, closed: false,
      startedAt: Date.now(), devices: [], capabilities:new Map(), answered: false, mediaStarted: false, nativeStarted: false };
    this.active = call;
    call.timer = this.setTimeout(() => { if (this.active === call) void this.end(true, "time_limit"); }, this.options.bridge.max_call_seconds * 1000);
    return call;
  }

  async workers(call) {
    this.check(call);
    call.worker = this.workerFactory();
    call.bridge = this.bridgeFactory();
    call.worker.on("failure", () => { if (this.active === call) void this.end(true, "worker_failed"); });
    call.bridge.on("failure", () => { if (this.active === call) void this.end(true, "voice_failed"); });
    call.worker.on("event", event => {
      if (this.active !== call || call.closed || event.call_id !== call.id) return;
      if (event.type === "recording_failed") { this.recordings?.failed(); return; }
      if (event.type === "media_ended") { void this.end(true, "media_ended"); return; }
      if (event.type === "call_started") call.mediaStarted = true;
      if (event.type === "audio" && !call.answered) { call.preAnswerAudio = event; return; }
      void call.bridge.send(event).catch(() => this.failed(call));
    });
    call.bridge.on("event", event => {
      if (this.active !== call || call.closed || event.type !== "command" || event.call_id !== call.id) return;
      if (event.action === "hangup") { void this.end(true, "goodbye"); return; }
      if (event.action === "audio" || event.action === "flush") {
        void call.worker.send({ action: event.action, call_id: call.id, ...(event.action === "audio" ? { data: event.data } : {}) }).catch(() => this.failed(call));
      }
    });
    await Promise.all([call.worker.ready, call.bridge.ready]);
    this.check(call);
    const options = { ...this.options.bridge };
    if (call.greetingText) {
      options.greeting_text = call.greetingText;
      options.randomize_greeting = false;
    } else if (options.randomize_greeting && options.greeting_text.trim()) {
      const choices = GREETINGS.filter(greeting => greeting !== this.lastGreeting);
      options.greeting_text = choices[crypto.randomInt(choices.length)];
      this.lastGreeting = options.greeting_text;
      options.randomize_greeting = false;
    }
    await call.bridge.request("configure", { options });
    this.check(call);
  }

  async resolvePeer(peer, call, preserveDevice = false) {
    if (peer.endsWith("@lid")) return preserveDevice ? peer : peer.replace(/:\d+@/, "@");
    const matches = await this.socket.onWhatsApp(peer);
    this.check(call);
    const lid = matches?.find(item => item.exists && typeof item.lid === "string")?.lid;
    if (!lid || !lid.endsWith("@lid")) throw new Error("callee_lid_unavailable");
    const normalized = userJid(lid).replace(/:\d+@/, "@");
    if (!preserveDevice) return normalized;
    const device = this.baileys.jidDecode(peer)?.device ?? this.baileys.jidDecode(lid)?.device ?? 0;
    return this.baileys.jidEncode(this.baileys.jidDecode(normalized).user, "lid", device);
  }

  async signal(call, operation) {
    this.check(call);
    const work = async () => { this.check(call); return operation(); };
    const transaction = () => this.socket.authState.keys.transaction(work);
    const result = this.socket.processingMutex?.mutex ? await this.socket.processingMutex.mutex(transaction) : await transaction();
    this.check(call);
    return result;
  }

  async send(call, node) {
    this.check(call);
    await this.socket.sendNode(decodeNode(node));
    this.check(call);
  }

  async dial(target, { message } = {}) {
    userJid(target);
    if (message !== undefined && (typeof message !== "string" || !message.trim() || message.length > 300)) throw new TypeError("Invalid opening message.");
    const id = "00" + crypto.randomBytes(15).toString("hex");
    const call = this.reserve(id, target, null, "outgoing");
    call.greetingText = message;
    try {
      await this.workers(call);
      const peer = await this.resolvePeer(target, call);
      call.peer = peer;
      const socket = this.socket;
      const baileys = this.baileys;
      const devices = await socket.getUSyncDevices([peer], false, false);
      this.check(call);
      call.devices = [...new Set(devices.map(device => baileys.jidEncode(device.user, "lid", device.device)))];
      if (!call.devices.length || call.devices.length > 64) throw new Error("callee_devices_unavailable");
      // Paired accounts normally have this. Refuse before advancing a Signal chain if absent.
      const account = socket.authState.creds.account;
      if (!account) throw new Error("device_identity_unavailable");
      const identity = baileys.encodeSignedDeviceIdentity(account, true);
      await socket.assertSessions(call.devices);
      this.check(call);
      call.key = crypto.randomBytes(32);
      const padded = baileys.encodeWAMessage({ call: { callKey: call.key } });
      const encrypted = [];
      for (const jid of call.devices) {
        const result = await this.signal(call, () => socket.signalRepository.encryptMessage({ jid, data: padded }));
        encrypted.push({ jid, enc_type: result.type, ciphertext: Buffer.from(result.ciphertext).toString("base64") });
      }
      padded.fill(0);
      const privacy = this.privacy.get(peer);
      const offer = await call.worker.request("offer", { call_id: id, peer_lid: peer, self_lid: call.own,
        stanza_id: socket.generateMessageTag(), device_keys: encrypted, multi_device: call.devices.length > 1,
        device_identity: Buffer.from(identity).toString("base64"), ...(privacy ? { privacy_token:privacy.toString("base64") } : {}), audio_codec:this.options.bridge.audio_codec });
      this.check(call);
      const ack = await socket.query(decodeNode(offer.node), 10000);
      this.check(call);
      // Same post-offer token exchange as the Rust facade; failure does not invalidate a call.
      if (typeof socket.getPrivacyTokens === "function") void socket.getPrivacyTokens([peer]).then(result => this.capturePrivacy(result)).catch(() => {});
      await this.startMedia(call, ack);
      return { status:"calling" };
    } catch (error) {
      if (this.active === call) await this.end(true, "setup_failed");
      throw error;
    }
  }

  async incoming(node) {
    const info = callInfo(node);
    if (!info) return;
    if (info.action === "offer") {
      if (!this.options.live || !this.options.bridge.agent_id || this.active || info.child.attrs.type === "group" || info.child.attrs["group-jid"] || info.child.content?.some?.(child => child.tag === "video")) return;
      if (!this.options.callers.some(jid => sameUser(jid, info.from) || sameUser(jid, info.creator))) return;
      const call = this.reserve(info.id, info.from, info.creator, "incoming");
      try {
        await this.workers(call);
        const prepared = await call.worker.request("prepare", { node:encodeNode(node), self_lid:call.own,
          preaccept_id:this.socket.generateMessageTag(), accept_id:this.socket.generateMessageTag(), audio_codec:this.options.bridge.audio_codec });
        this.check(call);
        if (prepared.call_id !== call.id || prepared.creator !== call.creator) throw new Error("invalid_prepared_call");
        if (prepared.receipt) await this.send(call, prepared.receipt);
        await this.send(call, prepared.preaccept);
        const plain = await this.signal(call, () => this.socket.signalRepository.decryptMessage({ jid:prepared.creator, type:prepared.enc_type, ciphertext:decodeBytes(prepared.ciphertext, 8192) }));
        const message = this.baileys.proto.Message.decode(this.baileys.unpadRandomMax16(plain));
        call.key = Buffer.from(message.call?.callKey || []);
        if (call.key.length !== 32) throw new Error("invalid_call_key");
        if (plain instanceof Uint8Array) plain.fill(0);
        // Validate relay/key material and bring media up before sending the final accept.
        await this.startMedia(call, node, await this.resolvePeer(call.creator, call, true));
        await this.send(call, prepared.accept);
        call.answered = true;
        await this.releasePreAnswerAudio(call);
      } catch (error) {
        if (this.active === call) await this.end(true, "setup_failed");
        throw error;
      }
      return;
    }
    const call = this.active;
    if (!call || info.id !== call.id || !sameUser(info.creator, call.creator) || !sameUser(info.from, call.peer)) return;
    if (call.direction === "outgoing" && !call.answered && ["preaccept", "accept"].includes(info.action)) {
      const peer = await call.worker.request("peer", {node:encodeNode(node)});
      this.check(call);
      if (call.answered) return;
      if (peer.audio_supported === false) { await this.end(true, "audio_profile_mismatch"); return; }
      const device = info.from.replace(/:0@/, "@");
      if (peer.capability && peer.capability !== "unknown" && call.capabilities.size < 64) call.capabilities.set(device, peer.capability);
      call.answerCodec = this.options.bridge.audio_codec === "opus" || call.capabilities.get(device) === "clear" ? "opus" : "mlow";
    }
    if (["terminate", "reject"].includes(info.action)) {
      if (call.direction === "outgoing" && call.answerer && !sameDevice(info.from, call.answerer)) return;
      // A busy or undecryptable companion has not declined for the phone.
      if (call.direction === "outgoing" && !call.answered && info.action === "reject") {
        if (["busy", "enc"].includes(info.child.attrs.reason)) return;
        await this.dismissSiblings(call, info.from, "rejected_elsewhere");
      }
      await this.end(false, "peer_ended");
    } else if (info.action === "accept" && call.direction === "outgoing" && !call.answered) {
      call.answered = true;
      call.answerer = info.from;
      if (call.nativeStarted) await call.worker.request("answer", { call_id:call.id, answering_lid:call.answerer, audio_codec:call.answerCodec });
      await this.releasePreAnswerAudio(call);
      await this.dismissSiblings(call, call.answerer, "accepted_elsewhere");
    }
  }

  async dismissSiblings(call, answeringDevice, reason) {
    if (call.dismissed) return;
    call.dismissed = true;
    for (const device of call.devices.filter(device => !sameDevice(device, answeringDevice))) {
      const built = await call.worker.request("terminate", { call_id:call.id, to:device, creator:call.creator,
        stanza_id:this.socket.generateMessageTag(), reason });
      await this.send(call, built.node);
    }
  }

  async startMedia(call, node, peer = call.peer) {
    this.check(call);
    call.recordingFilename = this.recordings?.begin();
    await call.worker.request("start", { call_id:call.id, direction:call.direction, self_lid:call.own, peer_lid:peer,
      call_key:call.key.toString("base64"), node:encodeNode(node), audio_codec:this.options.bridge.audio_codec,
      playback_buffer_ms:this.options.bridge.playback_buffer_ms,
      ...(call.recordingFilename ? { recording_filename:call.recordingFilename, recording_active:call.answered } : {}) }, 20000);
    this.check(call);
    call.nativeStarted = true;
    call.key.fill(0);
    if (call.answerer) await call.worker.request("answer", { call_id:call.id, answering_lid:call.answerer, audio_codec:call.answerCodec });
    await this.releasePreAnswerAudio(call);
  }

  async releasePreAnswerAudio(call) {
    this.check(call);
    if (call.answered && call.nativeStarted && call.recordingFilename && !call.recordingStarted) {
      call.recordingStarted = true;
      await call.worker.request("record", { call_id:call.id });
      this.check(call);
    }
    if (call.answered && call.preAnswerAudio) {
      const audio = call.preAnswerAudio;
      call.preAnswerAudio = null;
      await call.bridge.send(audio);
    }
  }

  failed(call = this.active) {
    this.lastError = "voice_operation_failed";
    if (call && this.active === call) void this.end(true, "voice_failed");
  }

  end(notifyPeer = true, reason = "local_hangup") {
    if (this.endTask) return this.endTask;
    const call = this.active;
    if (!call) return Promise.resolve();
    this.active = null;
    call.closed = true;
    this.clearTimeout(call.timer);
    call.key?.fill(0);
    this.endTask = this.teardown(call, notifyPeer, reason).finally(() => { this.endTask = null; });
    return this.endTask;
  }

  async teardown(call, notifyPeer, reason) {
    // Keep the current messaging socket untouched, even if worker shutdown fails.
    if (notifyPeer && this.connected && this.generation === call.generation) {
      const targets = call.answerer ? [call.answerer] : call.direction === "outgoing" && call.devices.length ? call.devices : [call.peer];
      for (const to of targets) {
        try {
          const node = terminateNode(call, to, this.socket.generateMessageTag());
          if (this.connected && this.generation === call.generation) await this.socket.sendNode(node);
        } catch { /* Teardown must finish even when the network/worker is gone. */ }
      }
    }
    try { await call.bridge?.send({ type:"call_ended", call_id:call.id }); } catch { /* Already closed. */ }
    if (!call.nativeStarted) call.worker?.close();
    try { await call.worker?.request("stop", { call_id:call.id }); } catch { /* Already closed. */ }
    call.worker?.close();
    this.recordings?.release(call.recordingFilename);
    void this.recordings?.completed?.(call.recordingFilename, !!call.recordingStarted);
    // Let GPT-Live finish its bounded close/final usage handshake before stopping Python.
    if (call.bridge && !call.bridge.closed) {
      try { await call.bridge.request("shutdown", {}, 5000); } catch { /* Bounded by process timeout. */ }
      call.bridge.close();
    }
    this.lastError = ["setup_failed", "worker_failed", "voice_failed"].includes(reason) ? reason : null;
  }

  status() {
    return { live_mode:this.options.live, configured:!!this.options.clientId && !!this.options.bridge.agent_id, connected:this.connected, active:!!this.active || !!this.endTask,
      state:!this.options.clientId || !this.options.bridge.agent_id ? "unconfigured" : this.endTask ? "ending" : this.active ? (this.active.answered ? "in_call" : "calling") : this.connected ? "ready" : "disconnected",
      direction:this.active?.direction || null, last_error:this.lastError,
      recording:{ ...(this.recordings?.status() || { enabled:false, retention_days:30, available:false, last_error:null }),
        active:!!this.active?.recordingStarted && !this.recordings?.lastError } };
  }

  async close() { await this.end(true, "shutdown"); this.detach(); }
}

function withCalls(baileysPromise, controller) {
  return Promise.resolve(baileysPromise).then(baileys => ({ ...baileys, default: config => {
    const socket = baileys.default(config);
    controller.attach(socket, baileys);
    return socket;
  } }));
}

module.exports = { CallController, callInfo, sameDevice, selfIdentity, terminateNode, withCalls };
