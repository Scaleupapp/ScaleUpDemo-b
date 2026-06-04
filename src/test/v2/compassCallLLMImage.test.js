// src/test/v2/compassCallLLMImage.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const ANTHROPIC = path.resolve(__dirname, '../../config/anthropic.js');
const REDIS = path.resolve(__dirname, '../../config/redis.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }
function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async () => 0, expire: async () => 1, get: async () => '0' }; }

test('callLLM: builds a Claude image content block when image is provided', async () => {
  stub(REDIS, fakeRedis());
  let captured;
  stub(ANTHROPIC, { messages: { create: async (req) => { captured = req; return { stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 40 }, content: [{ type: 'text', text: 'That is a recursion problem.' }] }; } } });
  const orch = load();
  const out = await orch.callLLM({ userId: 'u1', systemPrompt: 'sys', userPrompt: 'explain this', image: { base64: 'BASE64DATA', mimeType: 'image/jpeg' } });
  const lastMsg = captured.messages[captured.messages.length - 1];
  assert.ok(Array.isArray(lastMsg.content), 'content should be a block array when image present');
  assert.equal(lastMsg.content[0].type, 'image');
  assert.equal(lastMsg.content[0].source.type, 'base64');
  assert.equal(lastMsg.content[0].source.media_type, 'image/jpeg');
  assert.equal(lastMsg.content[0].source.data, 'BASE64DATA');
  assert.equal(lastMsg.content[1].type, 'text');
  assert.equal(lastMsg.content[1].text, 'explain this');
  assert.match(out.text, /recursion/);
});

test('callLLM: keeps plain string content when no image', async () => {
  stub(REDIS, fakeRedis());
  let captured;
  stub(ANTHROPIC, { messages: { create: async (req) => { captured = req; return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'hi' }] }; } } });
  const orch = load();
  await orch.callLLM({ userId: 'u1', systemPrompt: 'sys', userPrompt: 'hello' });
  const lastMsg = captured.messages[captured.messages.length - 1];
  assert.equal(lastMsg.content, 'hello'); // plain string, unchanged
});
