"use strict";
// Run with docker exec inside the normally booted image using --network none.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const { setTimeout:delay }=require("node:timers/promises");

async function main(){
  const root="http://127.0.0.1:3000";
  let healthy=false;
  for(let attempt=0;attempt<120;attempt++){
    try{
      const response=await fetch(root+"/health",{headers:{"x-ha-healthcheck":"docker"}});
      healthy=response.ok && (await response.json()).status==="ok";
    }catch{}
    if(healthy)break;
    await delay(250);
  }
  assert.equal(healthy,true,"Packaged app must boot and pass the original health route");
  // Docker exec can run before S6 has started the app and published its token.
  const token=fs.readFileSync("/data/.api-token","utf8").trim();
  assert.match(token,/^[a-f0-9]{64}$/);
  assert.equal(fs.statSync("/data/.api-token").mode & 0o777,0o600);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync("/data/options.json","utf8")),"api_token"),false);
  const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
  assert.equal((await fetch(root+"/voice/status")).status,401);
  assert.equal((await fetch(root+"/voice/recordings")).status,401);
  const recordings=await(await fetch(root+"/voice/recordings",{headers})).json();
  assert.equal(recordings.enabled,false,"Offline simulation cannot enable recording");
  assert.equal(recordings.retention_days,30);
  assert.deepEqual(recordings.recordings,[]);
  const state=await(await fetch(root+"/voice/status",{headers})).json();
  assert.equal(state.live_mode,false);assert.equal(state.connected,false);assert.equal(state.active,false);
  assert.equal((await fetch(root+"/voice/call",{method:"POST",headers,body:JSON.stringify({to:"222222222@lid"})})).status,409);
  assert.equal((await fetch(root+"/voice/call",{method:"POST",headers,body:JSON.stringify({to:"invalid"})})).status,400);
  assert.equal((await fetch(root+"/voice/hangup",{method:"POST",headers,body:"{}"})).status,200);
  assert.equal((await fetch("http://127.0.0.1:8099/voice/")).status,403);
  assert.equal((await fetch(root+"/synthetic-missing-route",{headers})).status,404);
  const supervisor=await(await fetch("http://127.0.0.1/fixture/requests")).json();
  const allowed=new Set(["/addons/self/info","/addons/self/options","/addons/self/options/config","/supervisor/ping","/info","/core/info","/supervisor/info","/os/info","/host/info"]);
  assert.ok(supervisor.length>0,"The original S6 bootstrap must have used the synthetic Supervisor");
  assert.ok(supervisor.every(request=>request.method==="GET" && allowed.has(request.path)));
  for(const pid of fs.readdirSync("/proc").filter(value=>/^\d+$/.test(value))){
    let command;try{command=fs.readFileSync("/proc/"+pid+"/cmdline","utf8");}catch{continue;}
    assert.ok(!command.includes("whatsapp-call-worker") && !command.includes("bridge/bridge.py"),"Offline boot must not spawn a voice worker");
  }
  assert.equal(fs.existsSync("/data/default/creds.json"),false);
  console.log(JSON.stringify({packaged_boot:"passed",base_health:"passed",voice_routes:"passed",bearer_auth:"passed",offline_call_gate:"passed",ingress_guard:"passed"}));
}
void main().catch(error=>{console.error(error.stack);process.exitCode=1;});
