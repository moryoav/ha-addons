"use strict";
// Run inside the built image with --network none. All identities and keys are synthetic.
const assert=require("node:assert/strict");
const path=require("node:path");
const root=process.env.VOICE_APP_DIR || "/app/voice";
const { JsonProcess,childEnvironment }=require(path.join(root,"process"));
const { decodeNode,encodeNode }=require(path.join(root,"wire"));
const { terminateNode }=require(path.join(root,"calls"));
const { SELF,PEER,ID,KEY,signalPair }=require("./helpers");

async function main(){
  const pair=await signalPair();
  const native=new JsonProcess("/usr/local/bin/whatsapp-call-worker",[],{env:childEnvironment()});
  const request=native.request.bind(native);
  native.request=async(action,args)=>{try{return await request(action,args);}catch(error){throw new Error("Offline native "+action+" failed",{cause:error});}};
  try{
    const encrypted=await pair.peer.repo.encryptMessage({jid:SELF,data:pair.baileys.encodeWAMessage({call:{callKey:KEY}})});
    const offer=await native.request("offer",{call_id:ID,peer_lid:SELF.replace(":3@","@"),self_lid:PEER,
      stanza_id:"synthetic-offer",device_keys:[{jid:SELF.replace(":3@",":9@"),enc_type:"msg",ciphertext:Buffer.alloc(48,2).toString("base64")},{jid:SELF,enc_type:encrypted.type,ciphertext:encrypted.ciphertext.toString("base64")}],
      multi_device:true,device_identity:Buffer.alloc(8,1).toString("base64"),audio_codec:"opus"});
    const inbound=decodeNode(offer.node);inbound.attrs={from:PEER,id:"synthetic-incoming",t:"1"};
    const prepared=await native.request("prepare",{node:encodeNode(inbound),self_lid:SELF,audio_codec:"opus",preaccept_id:"synthetic-preaccept",accept_id:"synthetic-accept"});
    assert.equal(prepared.creator,PEER);assert.equal(prepared.call_id,ID);
    assert.equal(decodeNode(prepared.receipt).tag,"receipt");
    assert.equal(decodeNode(prepared.preaccept).content[0].tag,"preaccept");
    assert.equal(decodeNode(prepared.accept).content[0].tag,"accept");
    const answer=decodeNode(prepared.preaccept);answer.attrs={from:PEER,id:"synthetic-preaccept",t:"1"};
    const peerProfile=await native.request("peer",{node:encodeNode(answer)});
    assert.equal(peerProfile.audio_supported,true);assert.equal(peerProfile.capability,"clear");
    const incompatible=structuredClone(inbound);
    incompatible.content[0].content.find(child=>child.tag==="audio").attrs.rate="48000";
    await assert.rejects(native.request("prepare",{node:encodeNode(incompatible),self_lid:SELF,audio_codec:"opus",preaccept_id:"synthetic-preaccept",accept_id:"synthetic-accept"}),/failed/);
    const plain=await pair.host.repo.decryptMessage({jid:prepared.creator,type:prepared.enc_type,ciphertext:Buffer.from(prepared.ciphertext,"base64")});
    assert.deepEqual(Buffer.from(pair.baileys.proto.Message.decode(pair.baileys.unpadRandomMax16(plain)).call.callKey),KEY);
    const direct=await native.request("offer",{call_id:ID,peer_lid:SELF.replace(":3@","@"),self_lid:PEER,
      stanza_id:"synthetic-direct",device_keys:[{jid:SELF,enc_type:encrypted.type,ciphertext:encrypted.ciphertext.toString("base64")}],
      multi_device:false,device_identity:Buffer.alloc(8,1).toString("base64"),audio_codec:"opus"});
    const directInbound=decodeNode(direct.node);directInbound.attrs={from:PEER,id:"synthetic-direct",t:"1"};
    const directPrepared=await native.request("prepare",{node:encodeNode(directInbound),self_lid:SELF,audio_codec:"opus",preaccept_id:"synthetic-preaccept",accept_id:"synthetic-accept"});
    assert.equal(directPrepared.ciphertext,prepared.ciphertext);
    const args={call_id:ID,to:PEER,creator:SELF,stanza_id:"synthetic-end"};
    const end=await native.request("terminate",args);
    assert.deepEqual(decodeNode(end.node),terminateNode({id:ID,creator:SELF},PEER,args.stanza_id));
    // This exercises the actual binary's explicit gate before any UDP socket exists.
    await assert.rejects(native.request("start",{call_id:ID}),/failed/);
    console.log(JSON.stringify({native_protocol:1,shared_baileys_signal_key:"passed",offer_and_accept_wire:"passed",termination_fallback:"passed",network_gate:"passed"}));
  }finally{native.close();}
}
module.exports = { main };
if (require.main === module) void main().catch(error=>{console.error(error.stack);process.exitCode=1;});
