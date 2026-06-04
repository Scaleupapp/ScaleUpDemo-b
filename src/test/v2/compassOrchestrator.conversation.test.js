// src/test/v2/compassOrchestrator.conversation.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const ANTHROPIC = path.resolve(__dirname, '../../config/anthropic.js');
const REDIS = path.resolve(__dirname, '../../config/redis.js');
const TOOLS = path.resolve(__dirname, '../../services/v2/compassTools.js');
const PROGRESS = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const CONV = path.resolve(__dirname, '../../models/CompassConversation.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }
function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async (k, n) => { const v = (m.get(k) || 0) - n; m.set(k, v); return v; }, expire: async () => 1, get: async () => '0' }; }

test('conversation: returns reply + cards from a tool round, injecting the snapshot', async () => {
  stub(REDIS, fakeRedis());
  stub(CONV, {}); // appendToThread is best-effort; stubbed model makes it no-op via its try/catch
  stub(PROGRESS, { getSnapshot: async () => ({ readiness: { value: 70, target: 80 } }), renderSnapshot: () => 'Readiness: 70% (target 80%).' });
  let call = 0;
  stub(ANTHROPIC, { messages: { create: async ({ system }) => {
    call += 1;
    assert.match(system, /Readiness: 70%/);   // snapshot injected
    assert.match(system, /NEVER state a number/i); // never-invent rule injected
    if (call === 1) return { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't', name: 'explain_readiness', input: {} }] };
    return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: "You're at 70% because two competencies are below target." }] };
  } } });
  stub(TOOLS, { TOOLS: [], dispatch: async () => ({ ok: true, output: '{"value":70}', card: { type: 'readiness_explanation', payload: { value: 70, target: 80 } } }) });

  const orch = load();
  const res = await orch.conversation({ ctx: {}, systemPrompt: 'You are Compass.', userId: 'u1', message: 'why am I stuck at 70?', history: [{ role: 'user', content: 'hi' }] });
  assert.match(res.output.reply, /70%/);
  assert.equal(res.output.cards[0].type, 'readiness_explanation');
});
