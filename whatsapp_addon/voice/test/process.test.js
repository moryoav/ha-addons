"use strict";
const assert=require("node:assert/strict");
const test=require("node:test");
const { EventEmitter }=require("node:events");
const { PassThrough }=require("node:stream");
const { JsonProcess,childEnvironment }=require("../process");

test("real private child pipes correlate requests and reject pending work on exit",async()=>{
  const script=`const r=require('node:readline').createInterface({input:process.stdin});
  console.log(JSON.stringify({type:'ready',protocol:1}));
  r.on('line',line=>{const c=JSON.parse(line);if(c.action==='exit')process.exit(0);
  else console.log(JSON.stringify({type:'response',id:c.id,ok:true,result:{received:c.value}}));});`;
  const child=new JsonProcess(process.execPath,["-e",script],{env:childEnvironment()});
  try {
    const results=await Promise.all([child.request("echo",{value:1}),child.request("echo",{value:2})]);
    assert.deepEqual(results,[{received:1},{received:2}]);
    await assert.rejects(child.request("exit"),/unavailable/);assert.equal(child.pending.size,0);
  } finally {child.close();}
});

test("a blocked audio pipe has a fixed memory budget instead of an unbounded promise queue",async()=>{
  const native=new EventEmitter();native.stdout=new PassThrough();native.stderr=new PassThrough();native.stdin=new PassThrough();
  native.kill=()=>native.emit("exit",0);native.stdin.write=()=>false;
  const child=new JsonProcess("synthetic",[],{spawnFn:()=>native});
  native.stdout.write(JSON.stringify({type:"ready",protocol:1})+"\n");await child.ready;
  const first=child.send({data:"x".repeat(600000)});first.catch(()=>{});
  await assert.rejects(child.send({data:"x".repeat(600000)}),/backpressure/);
  await assert.rejects(first,/unavailable/);assert.equal(child.closed,true);
});
