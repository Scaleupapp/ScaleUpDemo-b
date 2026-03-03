const fetch = require('node-fetch');

// Polyfill globals for Node 16 (Anthropic SDK expects Node 18+ globals)
if (typeof globalThis.Headers === 'undefined') {
  globalThis.Headers = fetch.Headers;
  globalThis.Request = fetch.Request;
  globalThis.Response = fetch.Response;
}

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  fetch,
});

module.exports = anthropic;
