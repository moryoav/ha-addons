"use strict";
// Synthetic Supervisor for a full S6 image boot with Docker --network none.
const http=require("node:http");
const fs=require("node:fs");
const options=JSON.parse(fs.readFileSync("/data/options.json","utf8"));
const requests=[];
const data={
  "/addons/self/info":{name:"Synthetic WhatsApp",slug:"local_whatsapp_addon",version:"3.0.0",options},
  "/addons/self/options":options,
  "/addons/self/options/config":options,
  "/supervisor/ping":{},
  "/info":{homeassistant:"0.0.0",supervisor:"0.0.0",operating_system:"Synthetic Linux",arch:"amd64",machine:"synthetic"},
  "/core/info":{version:"0.0.0",machine:"synthetic",arch:"amd64"},
  "/supervisor/info":{version:"0.0.0"},
  "/os/info":{version:"0.0.0"},
  "/host/info":{operating_system:"Synthetic Linux",kernel:"0.0.0",hostname:"synthetic"},
};
http.createServer((req,res)=>{
  res.setHeader("Content-Type","application/json");
  if(req.url==="/fixture/requests"){res.end(JSON.stringify(requests));return;}
  requests.push({method:req.method,path:req.url});
  console.log(JSON.stringify({synthetic_supervisor_request:req.url,method:req.method}));
  if(req.method!=="GET" || !Object.hasOwn(data,req.url)){
    res.statusCode=500;res.end(JSON.stringify({result:"error",message:"Unexpected synthetic Supervisor request"}));return;
  }
  res.end(JSON.stringify({result:"ok",data:data[req.url]}));
}).listen(80,"127.0.0.1");
