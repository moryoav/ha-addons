"use strict";

const { baseRequire } = require("./base");
const { parseOptions } = baseRequire("./runtime");

const USER_JID = /^[1-9]\d{4,30}(?::\d{1,5})?@(lid|s\.whatsapp\.net)$/;

function userJid(value) {
  if (typeof value !== "string" || !USER_JID.test(value)) {
    throw new TypeError("A WhatsApp user JID is required.");
  }
  return value;
}

function sameUser(first, second) {
  return typeof first === "string" && typeof second === "string" &&
    first.replace(/:\d+@/, "@") === second.replace(/:\d+@/, "@");
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function migrateVoiceOptions(raw) {
  object(raw, "options");
  const result = structuredClone(raw);
  const voice = object(result.voice_calls ?? {}, "voice_calls");
  const advanced = object(voice.advanced ?? {}, "voice_calls.advanced");
  const pick = (group, name, legacy, fallback) => Object.hasOwn(group, name) ? group[name] : raw[legacy] ?? fallback;
  const greetingMode = voice.greeting_mode ?? (raw.greeting_text === "" ? "disabled" : raw.randomize_greeting === false ? "fixed" : "random");
  const legacyAccount = (raw.voice_agent_id || voice.agent_id) && (raw.clients ?? ["default"]).includes("default") ? "default" : "";
  result.voice_calls = {
    ...voice,
    calling_account:Object.hasOwn(voice, "calling_account") ? voice.calling_account : pick(advanced, "calling_account", "voice_client", legacyAccount),
    allowed_callers:pick(voice, "allowed_callers", "allowed_callers", []),
    agent_id:pick(voice, "agent_id", "voice_agent_id", ""),
    voice:pick(voice, "voice", "voice", "gleam"),
    max_call_seconds:pick(voice, "max_call_seconds", "max_call_seconds", 300),
    greeting_mode:greetingMode,
    greeting_text:pick(voice, "greeting_text", "greeting_text", raw.randomize_greeting === false ? "Hello! How can I help?" : ""),
    automatic_hangup:pick(voice, "automatic_hangup", "automatic_hangup", true),
    record_calls:voice.record_calls ?? false,
    recording_retention_days:voice.recording_retention_days ?? 30,
    advanced:{
      ...advanced,
      audio_codec:pick(advanced, "audio_codec", "audio_codec", "opus"),
      playback_buffer_ms:pick(advanced, "playback_buffer_ms", "playback_buffer_ms", 180),
    },
  };
  for (const name of ["calling_account", "openai_entry_title", "agent_service"]) delete result.voice_calls.advanced[name];
  for (const name of ["decryption_diagnostics", "experimental_lid_sender_receipts",
    "live_mode", "voice_client", "voice_agent_id", "openai_entry_title", "agent_service",
    "allowed_callers", "voice", "audio_codec", "playback_buffer_ms", "max_call_seconds", "greeting_text",
    "randomize_greeting", "automatic_hangup"]) delete result[name];
  return result;
}

function parseVoiceOptions(raw, { simulation = false } = {}) {
  if (typeof simulation !== "boolean") throw new TypeError("simulation must be a boolean.");
  const settings = migrateVoiceOptions(raw);
  const voiceSettings = settings.voice_calls;
  const advanced = voiceSettings.advanced;
  const messaging = parseOptions(JSON.stringify(settings));
  const boolean = (name, fallback) => {
    const value = voiceSettings[name] ?? fallback;
    if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean.`);
    return value;
  };
  const integer = (name, fallback, min, max) => {
    const value = advanced[name] ?? voiceSettings[name] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} is outside its allowed range.`);
    return value;
  };
  const live = !simulation;
  const clientId = voiceSettings.calling_account;
  if (typeof clientId !== "string" || (clientId && !messaging.clientIds.includes(clientId))) throw new TypeError("Calling account must be a configured client.");
  const agentId = voiceSettings.agent_id;
  if (typeof agentId !== "string" || (agentId && !/^conversation\.[a-z0-9_]+$/.test(agentId))) throw new TypeError("Select a conversation entity for the Home Assistant agent.");
  const callers = voiceSettings.allowed_callers;
  if (!Array.isArray(callers) || callers.length > 32) throw new TypeError("allowed_callers must contain at most 32 user JIDs.");
  callers.forEach(userJid);
  const codec = advanced.audio_codec;
  if (!["opus", "mlow"].includes(codec)) throw new TypeError("Unsupported audio codec.");
  const voice = voiceSettings.voice;
  if (!["gleam", "meridian", "marin", "cedar", "shimmer", "alloy", "ash", "ballad", "coral", "echo", "sage", "verse",
    "quartz", "ripple", "vesper", "willow", "stone", "bossa", "tempo", "beacon", "delta", "cinder"].includes(voice)) throw new TypeError("Unsupported voice.");
  const greeting = voiceSettings.greeting_text;
  if (typeof greeting !== "string" || greeting.length > 300) throw new TypeError("Invalid voice text setting.");
  const greetingMode = voiceSettings.greeting_mode;
  if (!["random", "fixed", "disabled"].includes(greetingMode)) throw new TypeError("Unsupported greeting mode.");
  if (greetingMode === "fixed" && !greeting.trim()) throw new TypeError("Enter an opening greeting when Fixed is selected.");
  return {
    messaging, live, clientId, callers: [...new Set(callers)],
    recording: { enabled:boolean("record_calls", false), retentionDays:integer("recording_retention_days", 30, 1, 365) },
    bridge: {
      agent_id: agentId, voice,
      audio_codec: codec,
      playback_buffer_ms: integer("playback_buffer_ms", 180, 120, 1500),
      max_call_seconds: integer("max_call_seconds", 300, 60, 900),
      greeting_text: greetingMode === "disabled" ? "" : greeting || "Hello! How can I help?",
      randomize_greeting: greetingMode === "random",
      automatic_hangup: boolean("automatic_hangup", true),
    },
  };
}

module.exports = { parseVoiceOptions, migrateVoiceOptions, sameUser, userJid };
