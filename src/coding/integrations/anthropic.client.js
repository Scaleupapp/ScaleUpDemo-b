'use strict';

/**
 * Thin wrapper around the shared Anthropic client in src/config/anthropic.js.
 * Using the shared instance preserves any rate-limiting, logging, and polyfills
 * already configured there.
 */

// Shared client (applies the node-fetch polyfill + ANTHROPIC_API_KEY)
const client = require('../../config/anthropic');

/**
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} [opts.system]
 * @param {Array}  opts.messages
 * @param {Array}  [opts.tools]
 * @param {number} [opts.max_tokens=4096]
 * @returns {Promise<{content: Array, usage: object, stop_reason: string}>}
 */
async function call({ model, system, messages, tools, max_tokens = 4096 }) {
  const req = { model, system, messages, max_tokens };
  // Only include `tools` when there's at least one — the API rejects an empty
  // array, and forwarding undefined/[] would otherwise surface as a 400.
  if (Array.isArray(tools) && tools.length > 0) req.tools = tools;
  const res = await client.messages.create(req);
  return { content: res.content, usage: res.usage, stop_reason: res.stop_reason };
}

module.exports = { call };
