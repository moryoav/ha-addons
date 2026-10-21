"use strict";
const assert=require("node:assert/strict");
const test=require("node:test");
const { CallController,selfIdentity,withCalls }=require("../calls");
const { encodeNode }=require("../wire");
const { childEnvironment }=require("../process");
const { baseRequire }=require("../base");
const { WhatsappClient }=baseRequire("./whatsapp");
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const { SELF,PEER,PEER_DEVICE,ID,KEY,FakeWorker,testOptions,actionNode,signalPair,socketHarness }=require("./helpers");

function harness(options=testOptions(), socketOptions={}) {
  const workers=[],bridges=[];
  const controller=new CallController(options,{ workerFactory:()=>{ const p=new FakeWorker({native:true});workers.push(p);return p; },bridgeFactory:()=>{ const p=new FakeWorker();bridges.push(p);return p; } });
  const h=socketHarness(socketOptions);
  controller.attach(h.socket,h.baileys);
  h.socket.ev.emit("connection.update",{connection:"open"});
  return { ...h,controller,workers,bridges };
}

test("the disabled mode cannot spawn a worker, authenticate, or dial", async()=>{
  const h=harness(testOptions({simulation:true}));
  await assert.rejects(h.controller.dial(PEER),/disabled/);
  assert.equal(h.workers.length,0);assert.equal(h.queries.length,0);
  await h.controller.close();
});

test("an unset conversation agent leaves messaging connected and cannot start or answer a call",async()=>{
  const h=harness(testOptions({voice_calls:{agent_id:""}}));
  await assert.rejects(h.controller.dial(PEER),/conversation agent/);
  await h.controller.incoming({tag:"call",attrs:{from:PEER_DEVICE},content:[{tag:"offer",attrs:{"call-id":ID,"call-creator":PEER_DEVICE}}]});
  assert.equal(h.controller.status().connected,true);
  assert.equal(h.controller.status().configured,false);
  assert.equal(h.workers.length,0);assert.equal(h.bridges.length,0);assert.equal(h.sent.length,0);
  await h.controller.close();
});

test("the Baileys module wrapper preserves its exports and original socket options",async()=>{
  const h=harness();let optionsSeen,created=0;
  const wrapped=await withCalls({...h.baileys,proto:{synthetic:true},default:options=>{++created;optionsSeen=options;return h.socket;}},h.controller);
  const auth={synthetic:"auth-state"};const opts={auth,syncFullHistory:false};
  assert.equal(wrapped.default(opts),h.socket);assert.equal(optionsSeen,opts);assert.equal(optionsSeen.auth,auth);
  assert.equal(created,1);assert.equal(wrapped.proto.synthetic,true);await h.controller.close();
});

test("device identity retains the linked Baileys device number when LID is bare",()=>{
  const h=socketHarness();h.socket.authState.creds.me.lid="111111111@lid";
  assert.equal(selfIdentity(h.socket,h.baileys),SELF);
});

test("outbound calls encrypt for every device, use the same socket, and dismiss siblings once",async()=>{
  const h=harness();await h.controller.dial(PEER);
  const call=h.controller.active;
  const offer=h.workers[0].requests.find(r=>r.action==="offer");
  assert.equal(offer.device_keys.length,2);assert.equal(offer.self_lid,SELF);
  assert.equal(h.queries.length,1);assert.equal(h.bridges[0].events[0].type,"configure");
  const event=actionNode("accept",call.id,SELF,PEER_DEVICE);
  await h.controller.incoming(event);await h.controller.incoming(event);
  assert.equal(h.workers[0].requests.filter(r=>r.action==="answer").length,1);
  assert.equal(h.sent.filter(n=>n.content?.[0]?.attrs?.reason==="accepted_elsewhere").length,1);
  assert.ok(call.key.every(v=>v===0));
  await h.controller.close();assert.equal(h.controller.active,null);
});

test("call audio is withheld until an outgoing call is answered",async()=>{
  const h=harness();await h.controller.dial(PEER);const call=h.controller.active;
  const audio={type:"audio",call_id:call.id,data:Buffer.alloc(640).toString("base64")};
  h.workers[0].emit("event",audio);assert.equal(h.bridges[0].events.filter(e=>e.type==="audio").length,0);
  await h.controller.incoming(actionNode("accept",call.id,SELF,PEER_DEVICE));
  assert.equal(h.bridges[0].events.filter(e=>e.type==="audio").length,1,"Silence already decoded while ringing must be released after answer so greeting does not wait for new DTX audio");
  h.workers[0].emit("event",audio);assert.equal(h.bridges[0].events.filter(e=>e.type==="audio").length,2);
  await h.controller.close();
});

test("recording starts only after answer and a recorder error leaves the call running",async()=>{
  const h=harness();let failed=0,released=0;
  const filename="20260102T030405Z-0123456789abcdef0123456789abcdef.wav";
  h.controller.recordings={begin:()=>filename,release:()=>++released,failed:()=>++failed,
    status:()=>({enabled:true,available:true,retention_days:30,last_error:null})};
  await h.controller.dial(PEER);const call=h.controller.active;
  assert.equal(h.workers[0].requests.find(r=>r.action==="start").recording_filename,filename);
  assert.equal(h.workers[0].requests.find(r=>r.action==="start").recording_active,false);
  assert.equal(h.workers[0].requests.filter(r=>r.action==="record").length,0);
  await h.controller.incoming(actionNode("accept",call.id,SELF,PEER_DEVICE));
  assert.equal(h.workers[0].requests.filter(r=>r.action==="record").length,1);
  await h.controller.releasePreAnswerAudio(call);
  assert.equal(h.workers[0].requests.filter(r=>r.action==="record").length,1);
  h.workers[0].emit("event",{type:"recording_failed",call_id:call.id});
  assert.equal(failed,1);assert.equal(h.controller.active,call);assert.equal(h.controller.connected,true);
  assert.equal(h.workers[0].closed,false);assert.equal(h.bridges[0].closed,false);
  await h.controller.close();assert.equal(released,1);
});

test("ordinary calls send no recording command or file when recording is off",async()=>{
  const h=harness();await h.controller.dial(PEER);const call=h.controller.active;
  await h.controller.incoming(actionNode("accept",call.id,SELF,PEER_DEVICE));
  assert.equal(h.workers[0].requests.find(r=>r.action==="start").recording_filename,undefined);
  assert.equal(h.workers[0].requests.filter(r=>r.action==="record").length,0);
  await h.controller.close();
});

test("unrelated callers, video, group calls, and stale terminal events do not take over",async()=>{
  const h=harness();
  await h.controller.incoming(actionNode("offer",ID,"333333333@lid","333333333@lid"));
  const group=actionNode("offer",ID,PEER,PEER);group.content[0].attrs["group-jid"]="120363000000000000@g.us";
  await h.controller.incoming(group);assert.equal(h.workers.length,0);
  await h.controller.dial(PEER);const call=h.controller.active;
  await h.controller.incoming(actionNode("terminate","old-call",SELF,PEER_DEVICE));assert.equal(h.controller.active,call);
  await h.controller.incoming(actionNode("terminate",call.id,SELF,"333333333@lid"));assert.equal(h.controller.active,call);
  await h.controller.close();
});

test("reconnect discards old worker events without closing or logging out Baileys",async()=>{
  const h=harness();await h.controller.dial(PEER);const old=h.controller.active;
  const next=socketHarness();h.controller.attach(next.socket,next.baileys);next.socket.ev.emit("connection.update",{connection:"open"});
  await h.controller.dial(PEER);const current=h.controller.active;
  old.worker.emit("event",{type:"media_ended",call_id:old.id});
  old.bridge.emit("event",{type:"command",action:"hangup",call_id:old.id});
  assert.equal(h.controller.active,current);assert.equal(h.socket.ws.listenerCount("CB:call"),0);
  await h.controller.close();
});

test("a peer termination cancels setup before an offer can be sent",async()=>{
  let release;const h=harness();
  h.socket.getUSyncDevices=()=>new Promise(resolve=>{release=resolve;});
  const pending=h.controller.dial(PEER);
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const call=h.controller.active;await h.controller.incoming(actionNode("terminate",call.id,SELF,PEER_DEVICE));
  release([{user:"222222222",device:0}]);await assert.rejects(pending,/stale/);
  assert.equal(h.queries.length,0);assert.equal(h.controller.active,null);await h.controller.close();
});

test("call crypto and ordinary messages advance one real Baileys Signal store",async()=>{
  const {baileys,host,peer}=await signalPair();
  const h=harness(testOptions(),{baileys,host});
  const encrypted=await peer.repo.encryptMessage({jid:SELF,data:baileys.encodeWAMessage({call:{callKey:KEY}})});
  const node=actionNode("offer",ID,PEER,PEER);
  node.content[0].content=[{tag:"enc",attrs:{type:encrypted.type,v:"2"},content:encrypted.ciphertext}];
  const sendNode=h.socket.sendNode.bind(h.socket);
  h.socket.sendNode=async stanza=>{
    if(stanza.content?.[0]?.tag==="accept") {
      h.workers[0].emit("event",{type:"audio",call_id:ID,data:Buffer.alloc(640).toString("base64")});
      assert.equal(h.bridges[0].events.filter(event=>event.type==="audio").length,0,
        "Incoming silence must not start the greeting before the final WhatsApp accept is sent");
    }
    return sendNode(stanza);
  };
  const storeBefore=host.auth.keys;
  await h.controller.incoming(node);
  assert.equal(h.bridges[0].events.filter(event=>event.type==="audio").length,1,
    "Buffered silence starts the greeting once the incoming call is answered");
  const start=h.workers[0].requests.find(r=>r.action==="start");
  assert.equal(start.call_key,KEY.toString("base64"));assert.equal(host.auth.keys,storeBefore);
  for(let n=0;n<12;n++){
    const ordinary=await peer.repo.encryptMessage({jid:SELF,data:baileys.encodeWAMessage({conversation:"Synthetic message "+n})});
    const plain=await host.repo.decryptMessage({jid:PEER,type:ordinary.type,ciphertext:ordinary.ciphertext});
    assert.equal(baileys.proto.Message.decode(baileys.unpadRandomMax16(plain)).conversation,"Synthetic message "+n);
  }
  assert.equal(h.sent.filter(n=>n.content?.[0]?.tag==="accept").length,1);
  assert.equal(h.controller.status().state,"in_call");await h.controller.close();
});

test("random openings persist across bridge worker restarts and never repeat consecutively",async()=>{
  const h=harness();const choices=[];
  for(let n=0;n<12;n++) { await h.controller.dial(PEER);const opening=h.bridges.at(-1).events[0].options.greeting_text;assert.notEqual(opening,choices.at(-1));choices.push(opening);await h.controller.end(); }
  assert.ok(new Set(choices).size>1);await h.controller.close();
});

test("native workers never inherit HA or OpenAI credentials",()=>{
  const env=childEnvironment({PATH:"synthetic",SUPERVISOR_TOKEN:"synthetic-ha-secret",OPENAI_API_KEY:"synthetic-openai-secret",HA_TOKEN:"synthetic-token"});
  assert.deepEqual(env,{PATH:"synthetic"});
});

test("an incoming companion call preserves the offering device for SRTP identity",async()=>{
  const {baileys,host,peer}=await signalPair(PEER_DEVICE);
  const h=harness(testOptions(),{baileys,host});
  const encrypted=await peer.repo.encryptMessage({jid:SELF,data:baileys.encodeWAMessage({call:{callKey:KEY}})});
  const node=actionNode("offer",ID,PEER_DEVICE,PEER_DEVICE);
  node.content[0].content=[{tag:"enc",attrs:{type:encrypted.type,v:"2"},content:encrypted.ciphertext}];
  await h.controller.incoming(node);
  const start=h.workers[0].requests.find(r=>r.action==="start");
  assert.equal(start.peer_lid,PEER_DEVICE);assert.equal(start.call_key,KEY.toString("base64"));
  await h.controller.close();
});

test("failed HA configuration prevents an outgoing offer and preserves the messaging socket",async()=>{
  const h=harness();
  h.controller.bridgeFactory=()=>{
    const bridge=new FakeWorker();
    const request=bridge.request.bind(bridge);
    bridge.request=(action,args)=>action==="configure"?Promise.reject(new Error("synthetic_configuration_failure")):request(action,args);
    return bridge;
  };
  await assert.rejects(h.controller.dial(PEER),/configuration_failure/);
  assert.equal(h.queries.length,0);assert.equal(h.controller.connected,true);assert.equal(h.controller.socket,h.socket);
  assert.equal(h.controller.active,null);
  await h.controller.close();
});

test("MLOW negotiation retains each answering device's preaccept capability",async()=>{
  const h=harness(testOptions({audio_codec:"mlow"}));await h.controller.dial(PEER);const call=h.controller.active;
  const preaccept=actionNode("preaccept",call.id,SELF,PEER_DEVICE);
  preaccept.content[0].content=[{tag:"capability",attrs:{ver:"1"},content:Buffer.alloc(0)}];
  await h.controller.incoming(preaccept);
  const sibling=actionNode("preaccept",call.id,SELF,PEER);
  sibling.content[0].content=[{tag:"capability",attrs:{ver:"1"},content:Buffer.from([1])}];
  await h.controller.incoming(sibling);
  await h.controller.incoming(actionNode("accept",call.id,SELF,PEER_DEVICE));
  assert.equal(h.workers[0].requests.find(r=>r.action==="answer").audio_codec,"opus");
  await h.controller.close();
});

test("a busy or undecryptable companion leaves the phone ringing and retains sibling dismissal",async()=>{
  const h=harness();await h.controller.dial(PEER);const call=h.controller.active;
  for(const reason of ["busy","enc"]) {
    const rejection=actionNode("reject",call.id,SELF,PEER_DEVICE);rejection.content[0].attrs.reason=reason;
    await h.controller.incoming(rejection);assert.equal(h.controller.active,call);assert.equal(call.dismissed,undefined);
  }
  await h.controller.incoming(actionNode("accept",call.id,SELF,PEER));
  assert.equal(h.sent.filter(node=>node.content?.[0]?.attrs?.reason==="accepted_elsewhere").length,1);
  await h.controller.close();
});

test("a genuine decline dismisses the other linked devices while messaging stays connected",async()=>{
  const h=harness();await h.controller.dial(PEER);const call=h.controller.active;
  await h.controller.incoming(actionNode("reject",call.id,SELF,PEER_DEVICE));
  assert.equal(h.controller.active,null);assert.equal(h.controller.connected,true);
  assert.equal(h.sent.filter(node=>node.content?.[0]?.attrs?.reason==="rejected_elsewhere").length,1);
  await h.controller.close();
});

test("a native worker crash terminates the call and leaves Baileys available for another call",async()=>{
  const h=harness();await h.controller.dial(PEER);
  const call=h.controller.active;await h.controller.incoming(actionNode("accept",call.id,SELF,PEER_DEVICE));
  h.workers[0].close();await h.controller.end();
  assert.equal(h.controller.connected,true);assert.equal(h.controller.active,null);
  assert.ok(h.sent.some(node=>node.attrs.to===PEER_DEVICE&&node.content?.[0]?.tag==="terminate"));
  await h.controller.dial(PEER);assert.equal(h.workers.length,2);assert.equal(h.controller.lastError,null);
  await h.controller.close();
});

test("a dismissed sibling device cannot terminate the device that answered",async()=>{
  const h=harness();await h.controller.dial(PEER);const call=h.controller.active;
  await h.controller.incoming(actionNode("accept",call.id,SELF,PEER_DEVICE));
  const sibling=actionNode("terminate",call.id,SELF,PEER);sibling.content[0].attrs.reason="accepted_elsewhere";
  await h.controller.incoming(sibling);assert.equal(h.controller.active,call);
  await h.controller.incoming(actionNode("terminate",call.id,SELF,PEER_DEVICE));assert.equal(h.controller.active,null);
  await h.controller.close();
});

test("outgoing call keys are encrypted by the same Baileys session established by incoming traffic",async()=>{
  const {baileys,host,peer}=await signalPair();const h=harness(testOptions(),{baileys,host});
  const setup=await peer.repo.encryptMessage({jid:SELF,data:baileys.encodeWAMessage({conversation:"Synthetic session setup"})});
  await host.repo.decryptMessage({jid:PEER,type:setup.type,ciphertext:setup.ciphertext});
  h.socket.getUSyncDevices=async()=>[{user:"222222222",device:0}];
  await h.controller.dial(PEER);
  const offered=h.workers[0].requests.find(r=>r.action==="offer").device_keys[0];
  const plain=await peer.repo.decryptMessage({jid:SELF,type:offered.enc_type,ciphertext:Buffer.from(offered.ciphertext,"base64")});
  const key=baileys.proto.Message.decode(baileys.unpadRandomMax16(plain)).call.callKey;
  const start=h.workers[0].requests.find(r=>r.action==="start");assert.equal(Buffer.from(key).toString("base64"),start.call_key);
  const reply=await peer.repo.encryptMessage({jid:SELF,data:baileys.encodeWAMessage({conversation:"Synthetic follow-up"})});
  const decoded=await host.repo.decryptMessage({jid:PEER,type:reply.type,ciphertext:reply.ciphertext});
  assert.equal(baileys.proto.Message.decode(baileys.unpadRandomMax16(decoded)).conversation,"Synthetic follow-up");
  await h.controller.close();
});

test("two virtual minutes of call audio coexist with the unchanged messaging client",async()=>{
  const h=harness();let socketCreates=0,received=0,sent=0;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"wa-voice-coexist-"));
  const actual=await require("./helpers").baileysModule();
  const module={...actual,...h.baileys,
    default:()=>{++socketCreates;return h.socket;},
    fetchLatestBaileysVersion:async()=>({version:[2,3000,1]}),
    useMultiFileAuthState:async()=>({state:h.socket.authState,saveCreds:async()=>{}}),
  };
  h.socket.sendPresenceUpdate=async()=>{};
  h.socket.sendMessage=async(to,message)=>{++sent;return {key:{id:"synthetic-send-"+sent,remoteJid:to,fromMe:true},message:{conversation:message.text}};};
  h.socket.end=async()=>{};
  const client=new WhatsappClient({path:dir,baileys:withCalls(Promise.resolve(module),h.controller),autoConnect:false,offline:false});
  client.on("msg",()=>++received);
  try {
    await client.connect();h.socket.ev.emit("connection.update",{connection:"open"});
    await h.controller.dial(PEER);const call=h.controller.active;
    await h.controller.incoming(actionNode("accept",call.id,SELF,PEER_DEVICE));
    const pcm=Buffer.alloc(960*2).toString("base64");
    for(let n=0;n<2000;n++){
      call.worker.emit("event",{type:"audio",call_id:call.id,data:pcm});
      call.bridge.emit("event",{type:"command",action:"audio",call_id:call.id,data:pcm});
      if(n%20===0){
        h.socket.ev.emit("messages.upsert",{type:"notify",messages:[{key:{id:"synthetic-receive-"+n,remoteJid:PEER,fromMe:false},message:{conversation:"Synthetic message"}}]});
        await client.sendMessage(PEER,{text:"Synthetic reply"});
      }
    }
    assert.equal(socketCreates,1);assert.equal(sent,100);assert.equal(received,100);
    assert.equal(call.bridge.events.filter(e=>e.type==="audio").length,2000);
    assert.equal(call.worker.events.filter(e=>e.action==="audio").length,2000);
    assert.equal(h.controller.connected,true);
  } finally {
    await h.controller.close();await client.disconnect();
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test("an automation opening message overrides random greetings for one outgoing call only",async()=>{
  const options=testOptions();const original=structuredClone(options.bridge),h=harness(options);
  await h.controller.dial(PEER,{message:"Synthetic water leak alert"});
  const configured=h.bridges[0].events.find(x=>x.type==="configure").options;
  assert.equal(configured.greeting_text,"Synthetic water leak alert");assert.equal(configured.randomize_greeting,false);
  assert.deepEqual(options.bridge,original);
  await h.controller.end();
  await h.controller.dial(PEER);
  assert.notEqual(h.bridges[1].events.find(x=>x.type==="configure").options.greeting_text,"Synthetic water leak alert");
  await h.controller.close();
});
