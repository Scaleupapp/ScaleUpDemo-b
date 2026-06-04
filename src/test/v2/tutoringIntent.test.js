// src/test/v2/tutoringIntent.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const INTENT = path.resolve(__dirname, '../../services/v2/tutoringIntent.js');
const LLM_ROUTER = path.resolve(__dirname, '../../coding/services/llmRouter.js');
const PARSE = path.resolve(__dirname, '../../coding/services/drillGrader/parseLLMJson.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[INTENT]; return require(INTENT); }

test('maybeIsTutoringRequest: true for "help me get better at recursion"', () => {
  const { maybeIsTutoringRequest } = load();
  assert.equal(maybeIsTutoringRequest('help me get better at recursion'), true);
});
test('maybeIsTutoringRequest: true for "tutor me on dynamic programming"', () => {
  const { maybeIsTutoringRequest } = load();
  assert.equal(maybeIsTutoringRequest('tutor me on dynamic programming'), true);
});
test('maybeIsTutoringRequest: false for a plain content question', () => {
  const { maybeIsTutoringRequest } = load();
  assert.equal(maybeIsTutoringRequest('what is recursion?'), false);
});
test('detectTutoringRequest: returns start_tutoring with topic (stub LLM)', async () => {
  stub(LLM_ROUTER, { llmCall: async () => ({ content: '{"is_tutoring_request":true,"topic":"recursion"}' }) });
  stub(PARSE, { parseLLMJson: (c) => JSON.parse(c) });
  const { detectTutoringRequest } = load();
  const r = await detectTutoringRequest('help me get better at recursion');
  assert.equal(r.type, 'start_tutoring');
  assert.equal(r.topic, 'recursion');
});
test('detectTutoringRequest: null when LLM says not a tutoring request', async () => {
  stub(LLM_ROUTER, { llmCall: async () => ({ content: '{"is_tutoring_request":false}' }) });
  stub(PARSE, { parseLLMJson: (c) => JSON.parse(c) });
  const { detectTutoringRequest } = load();
  assert.equal(await detectTutoringRequest('help me get better at life'), null);
});
test('detectTutoringRequest: null (no throw) on LLM error', async () => {
  stub(LLM_ROUTER, { llmCall: async () => { throw new Error('net'); } });
  const { detectTutoringRequest } = load();
  assert.equal(await detectTutoringRequest('tutor me on arrays'), null);
});
