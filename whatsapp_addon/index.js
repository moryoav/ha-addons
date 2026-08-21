const log4js = require("log4js");

const { installLibsignalLogFilter } = require("./libsignal-log-filter");
const { startAddon } = require("./runtime");

const logger = log4js.getLogger();
logger.level = "info";
installLibsignalLogFilter({ logger });

const main = async () => {
  const runtime = await startAddon({ logger });
  let stopping = false;

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info("WhatsApp add-on stop requested.", {
      runId: runtime.runId,
      signal,
    });
    void runtime.close().catch(() => {
      logger.error("WhatsApp add-on shutdown did not complete cleanly.", {
        runId: runtime.runId,
      });
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};

void main().catch(() => {
  // Startup exceptions can contain configuration, filesystem, or upstream
  // details. Keep the console message actionable without echoing them.
  logger.fatal("WhatsApp add-on startup failed. Check the add-on configuration.");
  process.exitCode = 1;
});
