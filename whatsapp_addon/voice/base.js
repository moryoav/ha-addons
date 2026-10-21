"use strict";

const path = require("node:path");
const { createRequire } = require("node:module");

const baseDirectory = process.env.WHATSAPP_BASE_DIR || path.resolve(__dirname, "..");
const baseRequire = createRequire(path.join(baseDirectory, "package.json"));

module.exports = { baseDirectory, baseRequire };
