const log4js = require("log4js");

const { installLibsignalLogFilter } = require("./libsignal-log-filter");
const { startAddon } = require("./runtime");

const logger = log4js.getLogger();
logger.level = "info";
installLibsignalLogFilter({ logger });

void startAddon({ logger }).catch(() => {
  // Startup exceptions can contain configuration, filesystem, or upstream
  // details. Keep the console message actionable without echoing them.
  logger.fatal("WhatsApp add-on startup failed. Check the add-on configuration.");
  process.exitCode = 1;
});
