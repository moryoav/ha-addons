"use strict";

const MAX_BYTES = 256 * 1024;

function encodeNode(node, depth = 0, budget = { count: 0 }) {
  if (!node || typeof node.tag !== "string" || !/^[a-zA-Z0-9_:-]{1,80}$/.test(node.tag) || depth > 16 || ++budget.count > 1024) throw new TypeError("Invalid signaling node.");
  const attrs = {};
  for (const [key, value] of Object.entries(node.attrs || {})) {
    if (typeof value !== "string" || value.length > 4096 || key.length > 80) throw new TypeError("Invalid signaling attribute.");
    Object.defineProperty(attrs, key, { value, enumerable: true });
  }
  let content = null;
  if (Array.isArray(node.content)) content = node.content.map(child => encodeNode(child, depth + 1, budget));
  else if (node.content instanceof Uint8Array) {
    if (node.content.byteLength > MAX_BYTES) throw new TypeError("Signaling content is too large.");
    content = { bytes: Buffer.from(node.content).toString("base64") };
  } else if (typeof node.content === "string") content = { bytes: Buffer.from(node.content).toString("base64") };
  else if (node.content != null) throw new TypeError("Unsupported signaling content.");
  return { tag: node.tag, attrs, content };
}

function decodeNode(node, depth = 0, budget = { count: 0 }) {
  if (!node || typeof node.tag !== "string" || depth > 16 || ++budget.count > 1024) throw new TypeError("Invalid worker signaling node.");
  const result = { tag: node.tag, attrs: { ...node.attrs } };
  if (Array.isArray(node.content)) result.content = node.content.map(child => decodeNode(child, depth + 1, budget));
  else if (node.content != null) result.content = decodeBytes(node.content.bytes);
  return result;
}

function decodeBytes(value, max = MAX_BYTES) {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new TypeError("Invalid encoded bytes.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > max) throw new TypeError("Encoded bytes are too large.");
  return bytes;
}

module.exports = { encodeNode, decodeNode, decodeBytes };
