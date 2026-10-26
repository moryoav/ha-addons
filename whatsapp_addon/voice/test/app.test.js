"use strict";
const assert=require("node:assert/strict");
const test=require("node:test");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const { baseRequire }=require("../base");
const { startVoiceApp, isolatedHttpClient }=require("../app");
const { parseVoiceOptions, migrateVoiceOptions }=require("../options");
const { createVoiceApi,createVoiceIngress,renderVoiceUi }=require("../routes");
const { encodeNode,decodeNode }=require("../wire");

test("normal startup connects automatically and only the explicit test switch is offline",()=>{
  const options=parseVoiceOptions({clients:["default"]});
  assert.equal(options.live,true);
  assert.equal(parseVoiceOptions({clients:["default"], live_mode:false}).live,true);
  assert.equal(parseVoiceOptions({clients:["default"]}, {simulation:true}).live,false);
  const migrated=parseVoiceOptions({clients:["default"],voice_agent_id:"conversation.synthetic_agent",register_messaging_app:false,publish_message_events:false});
  assert.equal(migrated.live,true);
  assert.equal("registerMessagingApp" in migrated,false);
  assert.equal("publishEvents" in migrated,false);
  for(const change of [{voice_client:"missing"},{voice_agent_id:"sensor.synthetic"},{playback_buffer_ms:80},{audio_codec:"unknown"},{allowed_callers:["not-a-jid"]},{automatic_hangup:"yes"},{voice_calls:[]},{voice_calls:{advanced:[]}}])assert.throws(()=>parseVoiceOptions({clients:["default"],...change}));
});

test("grouped settings migration preserves messaging, caller restrictions, and audio tuning",()=>{
  const raw={clients:["default","secondary"],log_level:"debug",api_token:"synthetic-token",download_media:true,
    experimental_lid_sender_receipts:false,decryption_diagnostics:true,
    live_mode:true,voice_client:"secondary",voice_agent_id:"conversation.synthetic_agent",allowed_callers:["222222222@lid"],
    voice:"cedar",openai_entry_title:"Synthetic OpenAI",agent_service:"whatsapp_conversation_guard.process",
    audio_codec:"mlow",playback_buffer_ms:260,max_call_seconds:420,greeting_text:"Synthetic greeting",
    randomize_greeting:false,automatic_hangup:false};
  const original=structuredClone(raw);
  const before=parseVoiceOptions(raw), migrated=migrateVoiceOptions(raw);
  assert.deepEqual(raw,original,"Migration must not modify its input");
  assert.deepEqual(migrateVoiceOptions(migrated),migrated,"Migration must be idempotent");
  assert.deepEqual(parseVoiceOptions(migrated),before);
  assert.equal(migrated.live_mode,undefined);
  assert.equal(migrated.voice_agent_id,undefined);
  assert.deepEqual(migrated.clients,raw.clients);
  assert.equal(migrated.api_token,raw.api_token);
  for(const name of ["experimental_lid_sender_receipts","decryption_diagnostics"]){
    assert.equal(Object.hasOwn(migrated,name),false);
    assert.equal(Object.hasOwn(migrated.voice_calls.advanced,name),false);
  }
  assert.equal(migrated.download_media,true);
  assert.equal(migrated.voice_calls.greeting_mode,"fixed");
  assert.equal(migrated.voice_calls.calling_account,"secondary");
  assert.equal("calling_account" in migrated.voice_calls.advanced,false);
  assert.equal("agent_service" in migrated.voice_calls.advanced,false);
  assert.equal("openai_entry_title" in migrated.voice_calls.advanced,false);
});

test("legacy voice options never select an account that is missing or choose an unrelated account",()=>{
  for (const clients of [["house"], ["house", "other"]]) {
    for (const voice of [{voice_agent_id:"conversation.synthetic"}, {voice_calls:{agent_id:"conversation.synthetic"}}]) {
      const raw={clients,...voice}, migrated=migrateVoiceOptions(raw), settings=parseVoiceOptions(raw);
      assert.equal(settings.clientId, "");
      assert.deepEqual(settings.messaging.clientIds, clients);
      assert.deepEqual(migrateVoiceOptions(migrated), migrated);
    }
  }
  assert.equal(parseVoiceOptions({clients:["house"],voice_agent_id:"conversation.synthetic",voice_client:"house"}).clientId,"house");
  assert.equal(parseVoiceOptions({clients:["house","default"],voice_agent_id:"conversation.synthetic"}).clientId,"default");
});

test("moving calling account out of advanced preserves its value and honors an explicit replacement",()=>{
  const raw={clients:["default","secondary"],voice_calls:{agent_id:"conversation.selected",
    allowed_callers:["222222222@lid"],record_calls:true,recording_retention_days:45,
    advanced:{calling_account:"secondary",audio_codec:"mlow",playback_buffer_ms:260}}};
  const original=structuredClone(raw),before=parseVoiceOptions(raw),migrated=migrateVoiceOptions(raw);
  assert.deepEqual(raw,original);
  assert.equal(migrated.voice_calls.calling_account,"secondary");
  assert.equal("calling_account" in migrated.voice_calls.advanced,false);
  assert.deepEqual(migrateVoiceOptions(migrated),migrated);
  assert.deepEqual(parseVoiceOptions(migrated),before);
  assert.equal(before.clientId,"secondary");
  const replaced={...raw,voice_calls:{...raw.voice_calls,calling_account:"default"}};
  assert.equal(parseVoiceOptions(replaced).clientId,"default");
  assert.deepEqual(parseVoiceOptions(replaced).callers,before.callers);
  assert.deepEqual(parseVoiceOptions(replaced).bridge,before.bridge);
  assert.deepEqual(parseVoiceOptions(replaced).recording,before.recording);
  assert.throws(()=>parseVoiceOptions({...raw,voice_calls:{...raw.voice_calls,calling_account:"missing"}}),/configured client/);
});

test("grouped settings override legacy values and reject invalid nested selections",()=>{
  const raw={clients:["default"],voice_agent_id:"conversation.legacy",allowed_callers:["333333333@lid"],
    voice_calls:{agent_id:"conversation.selected",allowed_callers:[],advanced:{agent_service:"auto"}}};
  const options=parseVoiceOptions(raw);
  assert.equal(options.bridge.agent_id,"conversation.selected");
  assert.deepEqual(options.callers,[],"An intentionally empty allowlist must not restore legacy callers");
  assert.equal("agent_service" in options.bridge,false);
  for(const voice_calls of [{greeting_mode:"unknown"},{advanced:{calling_account:"missing"}},
    {advanced:{playback_buffer_ms:120.5}}]) {
    assert.throws(()=>parseVoiceOptions({clients:["default"],voice_calls}));
  }
});

test("obsolete key and service overrides are removed from grouped settings and worker options",()=>{
  const raw={clients:["default"],openai_entry_title:"Legacy entry",agent_service:"whatsapp_conversation_guard.process",
    voice_calls:{agent_id:"conversation.selected",advanced:{openai_entry_title:"Other entry",agent_service:"unknown.process"}}};
  const original=structuredClone(raw),migrated=migrateVoiceOptions(raw),options=parseVoiceOptions(raw);
  assert.deepEqual(raw,original);
  assert.deepEqual(migrateVoiceOptions(migrated),migrated);
  for(const group of [migrated,migrated.voice_calls.advanced,options.bridge]) {
    assert.equal("agent_service" in group,false);
    assert.equal("openai_entry_title" in group,false);
  }
  assert.equal(options.bridge.agent_id,"conversation.selected");
});

test("greeting modes preserve fixed text and let disabled override retained text",()=>{
  const base={clients:["default"]};
  const random=parseVoiceOptions({...base,voice_calls:{greeting_mode:"random",greeting_text:""}}).bridge;
  assert.equal(random.randomize_greeting,true);assert.ok(random.greeting_text);
  const fixed=parseVoiceOptions({...base,voice_calls:{greeting_mode:"fixed",greeting_text:"Synthetic greeting"}}).bridge;
  assert.equal(fixed.randomize_greeting,false);assert.equal(fixed.greeting_text,"Synthetic greeting");
  const disabled=parseVoiceOptions({...base,voice_calls:{greeting_mode:"disabled",greeting_text:"Retained text"}}).bridge;
  assert.equal(disabled.randomize_greeting,false);assert.equal(disabled.greeting_text,"");
  assert.throws(()=>parseVoiceOptions({...base,voice_calls:{greeting_mode:"fixed",greeting_text:" "}}));
  assert.equal(migrateVoiceOptions({...base,greeting_text:"",randomize_greeting:true}).voice_calls.greeting_mode,"disabled");
});

test("new and existing messaging-only accounts start without pre-reading WhatsApp credentials",async()=>{
  for(const rawOptions of [{clients:["house"]},{clients:["house"],voice_calls:{calling_account:"",agent_id:""}},
    {clients:["default"],voice_calls:{calling_account:"default",agent_id:"conversation.synthetic"}}]) {
    let started=false,reads=0;
    const runtime=await startVoiceApp({rawOptions,
      readFile:async()=>{reads++;throw Error("No existing credentials");},
      recordingStore:{start:async()=>{},close(){}},
      startAddonFn:async options=>{started=true;assert.deepEqual((await options.optionsLoader()).clientIds,rawOptions.clients);return {close:async()=>{}};},
    });
    assert.equal(started,true);assert.equal(reads,0);
    await runtime.close();
  }
  const settings=parseVoiceOptions({clients:["house"]});
  assert.equal(settings.clientId,"");assert.equal(settings.bridge.agent_id,"");
});

test("the offline app starts its existing API and never loads Baileys or contacts HA",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"wa-voice-offline-"));
  const apps=[];let loads=0,requests=0;
  const runtime=await startVoiceApp({rawOptions:{clients:["default"]},dataRoot:dir,simulation:true,
    logger:{info(){},warn(){},error(){}},supervisorToken:"synthetic-token",
    baileysLoader:()=>{++loads;throw Error("must not load");},
    httpClient:{post(){++requests;throw Error("must not request");}},
    diagnosticsFactory:()=>({runId:"synthetic-run",start:async()=>{},stop:async()=>{}}),
    replayHealthDiagnosticsFn:async()=>({records:[]}),readRecoveryRecordFn:async()=>null,
    listenFn:async(app,port)=>{apps.push({app,port});return {close:done=>done()};},
  });
  assert.equal(apps.length,2);assert.equal(loads,0);assert.equal(requests,0);
  assert.equal(runtime.voice.status().live_mode,false);
  const api=apps.find(item=>item.port===3000).app;
  const token=(await fs.readFile(path.join(dir,".api-token"),"utf8")).trim();
  const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
  let response=await request(api,"/voice/status");assert.equal(response.status,401);
  response=await request(api,"/voice/status",{headers});assert.equal(response.status,200);assert.equal((await response.json()).live_mode,false);
  response=await request(api,"/voice/call",{method:"POST",headers,body:JSON.stringify({to:"222222222@lid"})});
  assert.equal(response.status,409);
  response=await request(api,"/health");assert.equal(response.status,200);assert.equal((await response.json()).status,"ok");
  response=await request(api,"/synthetic-missing-route",{headers});assert.equal(response.status,404);
  await runtime.close();
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
  await fs.rm(dir,{recursive:true,force:true});
});

test("API and ingress routing uses the explicit listener role even with arbitrary ports",async()=>{
  const apps=[],express=baseRequire("express");
  const runtime=await startVoiceApp({rawOptions:{clients:["default"]}, simulation:true,
    recordingStore:{start:async()=>{},close(){},status:()=>({enabled:false})},
    listenFn:async(app,port)=>{apps.push({app,port});return {};},
    startAddonFn:async options=>{
      await options.listenFn(express(),0,{apiToken:"synthetic-token"});
      await options.listenFn(express(),0);
      return {close:async()=>{}};
    },
  });
  try {
    assert.equal((await request(apps[0].app,"/voice/status")).status,401);
    assert.equal((await request(apps[0].app,"/voice/status",{headers:{Authorization:"Bearer synthetic-token"}})).status,200);
    assert.equal((await request(apps[1].app,"/voice/status")).status,403);
  } finally { await runtime.close(); }
});

test("live messaging always publishes discovery and events; offline mode blocks both",async()=>{
  const calls=[];const client={post:async(...args)=>{calls.push(args);return {data:{}};}};
  const isolated=isolatedHttpClient(client,{live:false});
  await isolated.post("http://supervisor/discovery",{});
  await isolated.post("http://supervisor/core/api/events/new_whatsapp_message",{});
  assert.equal(calls.length,0);
  await isolatedHttpClient(client,{live:true}).post("http://supervisor/core/api/events/new_whatsapp_message",{synthetic:true});
  assert.equal(calls.length,1);
  await isolatedHttpClient(client,{live:true}).post("http://supervisor/discovery",{service:"whatsapp"});
  assert.equal(calls.length,2);
  assert.equal(calls[1][1].service,"whatsapp");
  await isolatedHttpClient(client,{live:false}).post("http://supervisor/discovery",{});
  assert.equal(calls.length,2);
});

test("inbox readiness requests reach the live transport and stay isolated offline",async()=>{
  const calls=[];
  const client={get:async(...args)=>{calls.push(args);return {data:{ready:true}};}};
  const url="http://supervisor/core/api/whatsapp/inbox";
  const options={headers:{Authorization:"Bearer synthetic-token"},timeout:10000};
  assert.deepEqual(await isolatedHttpClient(client,{live:true}).get(url,options),{data:{ready:true}});
  assert.deepEqual(calls,[[url,options]]);
  assert.deepEqual(await isolatedHttpClient(client,{live:false}).get(url,options),{data:{ready:false}});
  assert.equal(calls.length,1);
});

async function request(app,url,options) {
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  try { return await fetch("http://127.0.0.1:"+server.address().port+url,options); }
  finally { await new Promise(resolve=>server.close(resolve)); }
}

test("voice API applies existing bearer auth and does not expose private errors",async()=>{
  const express=baseRequire("express");const app=express();let count=0;
  const controller={status:()=>({active:false,connected:true}),dial:async()=>{++count;throw Error("synthetic-private-value");},end:async()=>{}};
  app.use("/voice",createVoiceApi(controller,"synthetic-token"));
  let response=await request(app,"/voice/status");assert.equal(response.status,401);
  response=await request(app,"/voice/call",{method:"POST",headers:{Authorization:"Bearer synthetic-token","Content-Type":"application/json"},body:JSON.stringify({to:"222222222@lid"})});
  assert.equal(response.status,503);assert.ok(!(await response.text()).includes("synthetic-private-value"));assert.equal(count,1);
});

test("voice ingress rejects direct network access and HTML escapes its base path",async()=>{
  const express=baseRequire("express");const app=express();
  app.use("/voice",createVoiceIngress({status:()=>({active:false})}));
  const response=await request(app,"/voice/status");assert.equal(response.status,403);
  const html=renderVoiceUi('/api/hassio_ingress/synthetic/\" onload=\"x');
  assert.ok(html.includes("&quot;"));assert.ok(!html.includes(' onload="x'));
});

test("voice ingress sends pairing visits to the pairing page unless calls were chosen",async()=>{
  const vm=require("node:vm");
  const html=renderVoiceUi("/api/hassio_ingress/synthetic");
  const script=html.slice(html.indexOf("<script>")+8,html.indexOf("</script>"));
  const run=async(search,clients)=>{
    const elements=new Map(),replaced=[];
    const element=()=>({hidden:false,textContent:"",disabled:false,prepend(){},append(){},remove(){}});
    const responses={"../api/status":{clients},recordings:{enabled:false,retention_days:30,recordings:[]},status:{state:"idle"}};
    vm.runInNewContext(script,{URLSearchParams,setInterval:()=>0,location:{search,replace:url=>replaced.push(url)},
      document:{getElementById:id=>elements.get(id)||elements.set(id,element()).get(id),createElement:element},
      fetch:async url=>({ok:true,json:async()=>responses[url]})});
    await new Promise(resolve=>setImmediate(resolve));
    return {replaced,banner:elements.get("pairing"),accounts:elements.get("pairing-accounts")};
  };
  const pairing=[{id:"default",state:"pairing"},{id:"secondary",state:"connected"}];
  assert.deepEqual((await run("",pairing)).replaced,["../"]);
  const calls=await run("?view=calls",pairing);
  assert.deepEqual(calls.replaced,[]);assert.equal(calls.banner.hidden,false);
  assert.equal(calls.accounts.textContent,"Waiting to be paired: default.");
  const paired=await run("",[{id:"default",state:"connected"}]);
  assert.deepEqual(paired.replaced,[]);assert.equal(paired.banner.hidden,true);
  assert.ok(html.includes('<a href="../">Open pairing page</a>'));
});

/** Keep implicit pairing navigation active after a reconnect gap or failed first poll. */
test("voice ingress retries pairing navigation when the first status is not ready",async()=>{
  const vm=require("node:vm");
  const html=renderVoiceUi("/api/hassio_ingress/synthetic");
  const script=html.slice(html.indexOf("<script>")+8,html.indexOf("</script>"));
  for(const search of ["","?view=calls"]){
    for(const firstPollFails of [false,true]){
      const elements=new Map(),replaced=[],intervals=[];
      let clients=[{id:"default",state:"connecting"}],fail=firstPollFails;
      /** Provide only the visible DOM properties used by the rendered calls page. */
      const element=()=>({hidden:false,textContent:"",disabled:false,prepend(){},append(){},remove(){}});
      vm.runInNewContext(script,{URLSearchParams,setInterval:callback=>intervals.push(callback),
        location:{search,replace:url=>replaced.push(url)},
        document:{getElementById:id=>elements.get(id)||elements.set(id,element()).get(id),createElement:element},
        fetch:async url=>{
          if(url==="../api/status"&&fail){fail=false;throw Error("Synthetic first-poll failure");}
          const responses={"../api/status":{clients},recordings:{enabled:false,retention_days:30,recordings:[]},status:{state:"idle"}};
          return {ok:true,json:async()=>responses[url]};
        }});
      await new Promise(resolve=>setImmediate(resolve));
      assert.deepEqual(replaced,[]);
      clients=[{id:"default",state:"pairing"}];
      await Promise.all(intervals.map(callback=>callback()));
      assert.deepEqual(replaced,search?[]:["../"],`Initial status failure: ${firstPollFails}, search: ${search}`);
      if(search) assert.equal(elements.get("pairing").hidden,false);
    }
  }
});

test("wire nodes retain binary bytes and fail before accepting malformed data",()=>{
  const node={tag:"call",attrs:{from:"222222222@lid"},content:[{tag:"enc",attrs:{v:"2"},content:Buffer.from([0,1,255])}]};
  assert.deepEqual(decodeNode(encodeNode(node)),node);
  assert.throws(()=>decodeNode({tag:"call",attrs:{},content:{bytes:"!"}}));
});

test("automation call routes enforce calling account and bound the opening message",async()=>{
  const express=baseRequire("express"),app=express(),seen=[];
  const controller={options:{clientId:"default"},status:()=>({}),dial:async(...args)=>{seen.push(args);return {status:"calling"};},end:async()=>{seen.push("hangup");}};
  app.use("/voice",createVoiceApi(controller,"synthetic-token"));
  const headers={Authorization:"Bearer synthetic-token","Content-Type":"application/json"};
  const post=(route,body)=>request(app,"/voice/"+route,{method:"POST",headers,body:JSON.stringify(body)});
  let response=await post("call",{clientId:"default",to:"222222222@lid",message:"Synthetic kitchen alert"});
  assert.equal(response.status,200);assert.deepEqual(seen[0],["222222222@lid",{message:"Synthetic kitchen alert"}]);
  for(const body of [{clientId:"other",to:"222222222@lid"},{to:"222222222@lid",message:" "},{to:"222222222@lid",message:"x".repeat(301)},{to:"222222222@lid",unexpected:true}])assert.equal((await post("call",body)).status,400);
  assert.equal(seen.length,1);
  assert.equal((await post("hangup",{clientId:"other"})).status,400);
  assert.equal((await post("hangup",{unexpected:true})).status,400);
  assert.equal((await post("hangup",{clientId:"default"})).status,200);
  assert.equal(seen.at(-1),"hangup");
});
