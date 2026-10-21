"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const { baseRequire } = require("./base");
const { parseVoiceOptions } = require("./options");
const { CallController, withCalls } = require("./calls");
const { createVoiceApi, createVoiceIngress } = require("./routes");
const { RecordingStore } = require("./recordings");
const { startAddon } = baseRequire("./runtime");
const { WhatsappClient, WhatsappDisconnectedError } = baseRequire("./whatsapp");

class OfflineClient extends EventEmitter {
  async disconnect() {}
  async logout() { throw new WhatsappDisconnectedError(); }
  async sendMessage() { throw new WhatsappDisconnectedError(); }
  get status() { return { connected:false, disconnected:true }; }
}

function isolatedHttpClient(client, { live }) {
  return { post(url, data, options) {
    // A live app owns messaging, events, and discovery together. Offline
    // simulation never contacts Home Assistant or takes over its integration.
    if (!live) {
      return Promise.resolve({ data:{} });
    }
    return client.post(url, data, options);
  } };
}

async function startVoiceApp({
  rawOptions, optionsPath="/data/options.json", dataRoot="/data", logger=console, simulation=false,
  startAddonFn=startAddon, controllerOptions={},
  baileysLoader=() => import(pathToFileURL(baseRequire.resolve("@whiskeysockets/baileys")).href),
  readFile=fs.readFile, listenFn, recordingStore, ...runtimeOptions
} = {}) {
  const options = parseVoiceOptions(rawOptions || JSON.parse(await readFile(optionsPath,"utf8")), { simulation });
  const recordings = recordingStore || new RecordingStore({ ...options.recording, enabled:options.live && options.recording.enabled, logger });
  void recordings.start();
  const controller = new CallController(options, { logger, recordings, ...controllerOptions });
  const runtimeLogger = new Proxy(logger, { get(target, key) {
    if (key === "info") return (message, ...facts) => target.info?.(!options.live && message === "WhatsApp add-on discovery registered."
      ? "Offline simulation discovery is disabled." : message, ...facts);
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const express = baseRequire("express");
  const serverListen = listenFn || ((app, port) => new Promise((resolve,reject) => {
    const server = app.listen(port, () => resolve(server)); server.once("error",reject);
  }));
  let runtime;
  try {
    runtime = await startAddonFn({
      ...runtimeOptions, logger:runtimeLogger, dataRoot,
      additionalCapabilities:["make_call", "hang_up"],
      optionsLoader:async () => options.messaging,
      httpClient:isolatedHttpClient(runtimeOptions.httpClient || baseRequire("axios"), options),
      clientFactory:clientOptions => {
        if (!options.live) return new OfflineClient();
        const selected = !!options.bridge.agent_id && path.basename(clientOptions.path) === options.clientId;
        return new WhatsappClient({ ...clientOptions, ...(selected ? { baileys:withCalls(baileysLoader(),controller) } : {}) });
      },
      listenFn:(app,port,{apiToken}={}) => {
        const outer = express();
        outer.disable("x-powered-by");
        if (port === (runtimeOptions.apiPort || 3000)) {
          if (!apiToken) throw new Error("Internal API authentication is required.");
          outer.use("/voice",createVoiceApi(controller,apiToken));
        } else {
          outer.use("/voice",createVoiceIngress(controller));
        }
        // Both original routers finish with a catch-all; mount additive routes first.
        outer.use(app);
        return serverListen(outer,port);
      },
    });
  } catch (error) {
    await controller.close();
    recordings.close();
    throw error;
  }
  let closing;
  return { ...runtime, voice:controller, close:() => closing ||= (async () => {
    await controller.close();
    recordings.close();
    await runtime.close();
  })() };
}

module.exports = { startVoiceApp, OfflineClient, isolatedHttpClient };
