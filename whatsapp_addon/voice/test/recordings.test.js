"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RecordingStore, FILENAME } = require("../recordings");
const { parseVoiceOptions } = require("../options");
const { createVoiceApi, createVoiceIngress, recordingRange } = require("../routes");
const { baseRequire } = require("../base");
const DAY = 86400000;
const NAME = "20260102T030405Z-0123456789abcdef0123456789abcdef.wav";
const OTHER = "20260102T030405Z-fedcba9876543210fedcba9876543210.wav";

function wave(samples = 16000) {
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF",0); data.writeUInt32LE(data.length-8,4); data.write("WAVEfmt ",8);
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22);
  data.writeUInt32LE(16000,24); data.writeUInt32LE(32000,28); data.writeUInt16LE(2,32);
  data.writeUInt16LE(16,34); data.write("data",36); data.writeUInt32LE(samples*2,40);
  for(let at=44;at<data.length;at+=2)data.writeInt16LE(1234,at);
  return data;
}

async function fixture(t, options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wa-recordings-test-"));
  const root = path.join(parent, "recordings");
  const store = new RecordingStore({ root, ...options });
  t.after(async () => { store.close(); await fs.rm(parent,{recursive:true,force:true}); });
  await store.start();
  return { store, root, parent };
}

async function server(t, store) {
  const express = baseRequire("express"), app = express();
  const controller = { recordings:store, status:()=>({active:false}) };
  app.use("/voice", createVoiceApi(controller, "synthetic-recording-secret"));
  app.use("/ingress/voice", createVoiceIngress(controller,{ allowedIngressAddress:"127.0.0.2" }));
  const running = app.listen(0,"127.0.0.1");
  await new Promise(resolve=>running.once("listening",resolve));
  t.after(()=>new Promise(resolve=>running.close(resolve)));
  return "http://127.0.0.1:"+running.address().port;
}

const headers = { Authorization:"Bearer synthetic-recording-secret" };

test("recording is off by default with a 30-day configurable retention", () => {
  assert.deepEqual(parseVoiceOptions({clients:["default"]}).recording,{enabled:false,retentionDays:30});
  assert.deepEqual(parseVoiceOptions({clients:["default"],voice_calls:{record_calls:true,recording_retention_days:7}}).recording,{enabled:true,retentionDays:7});
  for(const settings of [{record_calls:"yes"},{recording_retention_days:0},{recording_retention_days:366},{recording_retention_days:1.5}]){
    assert.throws(()=>parseVoiceOptions({clients:["default"],voice_calls:settings}));
  }
});

test("disabled recording creates no media directory or recording filename", async t => {
  const { store, root } = await fixture(t);
  assert.equal(store.begin(),null);
  assert.deepEqual(await store.list(),[]);
  await assert.rejects(fs.stat(root),{code:"ENOENT"});
  assert.equal(store.status().last_error,null);
});

test("only completed valid WAV files appear, with no caller identity in metadata", async t => {
  const { store, root } = await fixture(t,{enabled:true});
  await fs.writeFile(path.join(root,NAME),wave());
  await fs.writeFile(path.join(root,OTHER),"invalid-wave");
  await fs.writeFile(path.join(root,OTHER+".part"),wave());
  const records = await store.list();
  assert.equal(records.length,1); assert.equal(records[0].duration_seconds,1);
  assert.equal(records[0].created_at,"2026-01-02T03:04:05Z");
  assert.deepEqual(Object.keys(records[0]).sort(),["created_at","duration_seconds","expires_at","filename","size_bytes"]);
  const filename = store.begin(); assert.match(filename,FILENAME);
  assert.ok(!filename.includes("@")); store.release(filename);
});

test("expired files cannot be downloaded even before the next cleanup", async t => {
  const now = Date.now(); const { store, root } = await fixture(t,{enabled:true,now:()=>now});
  await fs.writeFile(path.join(root,NAME),wave());
  await fs.utimes(path.join(root,NAME),new Date(now-31*DAY),new Date(now-31*DAY));
  assert.equal(await store.open(NAME),null); assert.deepEqual(await store.list(),[]);
});

test("retention runs when disabled and removes only owned expired files", async t => {
  const now = Date.now(); const { store, root } = await fixture(t,{enabled:true,now:()=>now});
  for(const filename of [NAME,OTHER,NAME+".part","keep.txt","personal.wav"]){
    await fs.writeFile(path.join(root,filename),wave());
    await fs.utimes(path.join(root,filename),new Date(now-31*DAY),new Date(now-31*DAY));
  }
  store.active.add(OTHER); store.enabled = false;
  await store.cleanup();
  assert.deepEqual((await fs.readdir(root)).sort(),[OTHER,"keep.txt","personal.wav"].sort());
  store.release(OTHER); await store.cleanup();
  assert.deepEqual((await fs.readdir(root)).sort(),["keep.txt","personal.wav"]);
});

test("shorter retention applies to existing recordings and recent partials remain private", async t => {
  const now = Date.now(); const { store, root } = await fixture(t,{enabled:true,now:()=>now});
  await fs.writeFile(path.join(root,NAME),wave());
  await fs.utimes(path.join(root,NAME),new Date(now-8*DAY),new Date(now-8*DAY));
  await fs.writeFile(path.join(root,OTHER+".part"),wave());
  assert.equal((await store.list()).length,1);
  store.retentionDays = 7; await store.cleanup();
  assert.deepEqual(await fs.readdir(root),[OTHER+".part"]);
});

test("recording storage failure is contained and diagnostics omit private paths", async t => {
  const { root } = await fixture(t); const messages=[];
  await fs.writeFile(root,"not-a-directory");
  const store = new RecordingStore({root,enabled:true,logger:{warn:message=>messages.push(message)}});
  t.after(()=>store.close()); await store.start();
  assert.equal(store.available,false); assert.equal(store.begin(),null);
  assert.equal(messages.length,1); assert.ok(!messages[0].includes(root));
});

test("failed finalization reports a recording error but unanswered calls do not", async t => {
  const { store, root } = await fixture(t,{enabled:true});
  await store.completed(NAME,false); assert.equal(store.lastError,null);
  await store.completed(NAME,true); assert.ok(store.lastError);
  store.begin(); assert.equal(store.lastError,null);
  await fs.writeFile(path.join(root,NAME),wave());
  await store.completed(NAME,true); assert.equal(store.lastError,null);
});

test("authenticated recordings support seeking, download, and no-store responses", async t => {
  const { store, root } = await fixture(t,{enabled:true}); const audio=wave();
  await fs.writeFile(path.join(root,NAME),audio);
  const address=await server(t,store);
  assert.equal((await fetch(address+"/voice/recordings")).status,401);
  assert.equal((await fetch(address+"/voice/recordings/"+NAME)).status,401);
  assert.equal((await fetch(address+"/ingress/voice/recordings")).status,403);
  let response=await fetch(address+"/voice/recordings",{headers});
  assert.equal(response.status,200); assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal((await response.json()).recordings.length,1);
  response=await fetch(address+"/voice/recordings/"+NAME,{headers:{...headers,Range:"bytes=0-43"}});
  assert.equal(response.status,206); assert.equal(response.headers.get("content-range"),"bytes 0-43/"+audio.length);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),audio.subarray(0,44));
  response=await fetch(address+"/voice/recordings/"+NAME+"?download=1",{headers});
  assert.equal(response.status,200); assert.match(response.headers.get("content-disposition"),/^attachment;/);
  assert.equal(response.headers.get("content-type"),"audio/wav");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),audio);
  response=await fetch(address+"/voice/recordings/"+NAME,{headers:{...headers,Range:"bytes=999999-"}});
  assert.equal(response.status,416); await response.text();
  response=await fetch(address+"/voice/recordings/"+NAME,{method:"HEAD",headers});
  assert.equal(response.status,200); assert.equal(await response.text(),"");
  for(const name of ["outside.wav",NAME+".part","%2Fetc%2Fpasswd"]){
    response=await fetch(address+"/voice/recordings/"+name,{headers});
    assert.equal(response.status,404); await response.text();
  }
});

test("range validation rejects malformed, multiple, and oversized requests", () => {
  assert.deepEqual(recordingRange("bytes=-10",100),{start:90,end:99,partial:true});
  assert.deepEqual(recordingRange("bytes=90-",100),{start:90,end:99,partial:true});
  for(const range of ["bytes=-0","bytes=-","bytes=20-10","bytes=0-1,3-4","bytes=999-","bytes=9999999999999999999999-"]){
    assert.equal(recordingRange(range,100),null);
  }
});

test("symlinks cannot expose files outside the recording directory", async t => {
  const { store, root, parent } = await fixture(t,{enabled:true});
  const outside=path.join(parent,"outside.wav"); await fs.writeFile(outside,wave());
  try { await fs.symlink(outside,path.join(root,NAME)); }
  catch(error) { if(error.code === "EPERM"){t.skip("Symlink creation requires Windows permission; covered by packaged Linux tests.");return;}throw error; }
  assert.equal(await store.open(NAME),null); assert.deepEqual(await store.list(),[]);
  await store.cleanup(); assert.equal((await fs.stat(outside)).size,wave().length);
});

test("a symlinked storage directory is rejected without touching its target", async t => {
  const { parent } = await fixture(t); const outside=path.join(parent,"outside"); await fs.mkdir(outside);
  const linked=path.join(parent,"linked");
  try { await fs.symlink(outside,linked,"junction"); }
  catch(error) { if(error.code === "EPERM"){t.skip("Symlink permission unavailable; covered in Linux.");return;}throw error; }
  const store=new RecordingStore({root:linked,enabled:true});t.after(()=>store.close());
  await store.start();assert.equal(store.available,false);assert.deepEqual(await fs.readdir(outside),[]);
});
