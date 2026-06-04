// src/test/v2/compassTools.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const TOOLS_PATH = path.resolve(__dirname, '../../services/v2/compassTools.js');
const PROGRESS = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[TOOLS_PATH]; return require(TOOLS_PATH); }

test('TOOLS: exposes exactly the six read-only tools', () => {
  stub(PROGRESS, {});
  const { TOOLS } = load();
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ['explain_readiness', 'find_activity', 'get_latest_result', 'get_topic_detail', 'list_recent_activity', 'list_weak_topics']);
});

test('dispatch: routes get_latest_result to the service and emits an activity_result card', async () => {
  stub(PROGRESS, { getLatestResult: async (uid, type) => ({ activityType: type, title: 'X', overallScore: 72, scoreLabel: '72/100', dimensions: [], highlights: { strengths: [], improvements: [] }, date: null }) });
  const { dispatch } = load();
  const r = await dispatch({ userId: 'u1', name: 'get_latest_result', input: { activity_type: 'interview' } });
  assert.equal(r.ok, true);
  assert.equal(r.card.type, 'activity_result');
  assert.equal(r.card.payload.overallScore, 72);
  assert.match(r.output, /72/);
});

test('dispatch: list_weak_topics wraps payload as { topics }', async () => {
  stub(PROGRESS, { listWeakTopics: async () => [{ topic: 'recursion', score: 35, trend: 'declining', assessedBy: ['quiz'] }] });
  const { dispatch } = load();
  const r = await dispatch({ userId: 'u1', name: 'list_weak_topics', input: {} });
  assert.equal(r.card.type, 'weak_topics');
  assert.equal(r.card.payload.topics[0].topic, 'recursion');
});

test('dispatch: never throws — service error becomes ok:false with error output', async () => {
  stub(PROGRESS, { explainReadiness: async () => { throw new Error('db down'); } });
  const { dispatch } = load();
  const r = await dispatch({ userId: 'u1', name: 'explain_readiness', input: {} });
  assert.equal(r.ok, false);
  assert.equal(r.card, null);
  assert.match(r.output, /could not/i);
});

test('dispatch: unknown tool → ok:false', async () => {
  stub(PROGRESS, {});
  const { dispatch } = load();
  const r = await dispatch({ userId: 'u1', name: 'nope', input: {} });
  assert.equal(r.ok, false);
});
