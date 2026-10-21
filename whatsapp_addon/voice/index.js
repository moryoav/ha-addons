"use strict";

const { baseRequire } = require("./base");
const { startVoiceApp } = require("./app");
const { installLibsignalLogFilter } = baseRequire("./libsignal-log-filter");
const logger = baseRequire("log4js").getLogger();
logger.level = "info";

async function main() {
  const libsignalFilter = installLibsignalLogFilter({ logger });
  const runtime = await startVoiceApp({ logger, libsignalFilter, simulation:process.argv.includes("--offline-simulation") });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void runtime.close().catch(() => { process.exitCode=1; });
  };
  process.once("SIGINT",stop);
  process.once("SIGTERM",stop);
}

void main().catch(() => {
  logger.fatal("WhatsApp could not start. Check its configuration and existing session.");
  process.exitCode=1;
});
