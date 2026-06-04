// src/test/v2/compassOrchestrator.toolloop.test.js
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
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }

function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async (k, n) => { const v = (m.get(k) || 0) - n; m.set(k, v); return v; }, expire: async () => 1, get: async (k) => String(m.get(k) || 0) }; }

test('callLLMWithTools: runs one tool round then returns final text + cards', async () => {
  stub(REDIS, fakeRedis());
  let call = 0;
  stub(ANTHROPIC, { messages: { create: async () => {
    call += 1;
    if (call === 1) return { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'get_latest_result', input: { activity_type: 'interview' } }] };
    return { stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 12 }, content: [{ type: 'text', text: 'You scored 72 on your last interview — structure was strong.' }] };
  } } });
  stub(TOOLS, { TOOLS: [{ name: 'get_latest_result' }], dispatch: async () => ({ ok: true, output: '{"overallScore":72}', card: { type: 'activity_result', payload: { overallScore: 72 } } }) });

  const orch = load();
  const out = await orch.callLLMWithTools({ userId: 'u1', systemPrompt: 'sys', userPrompt: 'how did my last interview go?', history: [] });
  assert.match(out.text, /72/);
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].type, 'activity_result');
  assert.equal(call, 2);
});

test('callLLMWithTools: dedupes cards by type and caps at 2', async () => {
  stub(REDIS, fakeRedis());
  let call = 0;
  stub(ANTHROPIC, { messages: { create: async () => {
    call += 1;
    if (call === 1) return { stop_reason: 'tool_use', usage: {}, content: [
      { type: 'tool_use', id: 'a', name: 'get_latest_result', input: { activity_type: 'quiz' } },
      { type: 'tool_use', id: 'b', name: 'get_latest_result', input: { activity_type: 'interview' } },
      { type: 'tool_use', id: 'c', name: 'list_weak_topics', input: {} },
    ] };
    return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'done' }] };
  } } });
  stub(TOOLS, { TOOLS: [], dispatch: async ({ name }) => ({ ok: true, output: '{}', card: { type: name === 'list_weak_topics' ? 'weak_topics' : 'activity_result', payload: {} } }) });
  const orch = load();
  const out = await orch.callLLMWithTools({ userId: 'u1', systemPrompt: 's', userPrompt: 'p', history: [] });
  assert.equal(out.cards.length, 2);                    // capped
  assert.deepEqual(out.cards.map((c) => c.type), ['activity_result', 'weak_topics']); // deduped by type
});
