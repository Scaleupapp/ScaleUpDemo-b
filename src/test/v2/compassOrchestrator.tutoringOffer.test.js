// src/test/v2/compassOrchestrator.tutoringOffer.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }

test('attachProactiveTutoringOffer: offers start_tutoring from a weak_topics card', () => {
  const orch = load();
  const response = { mode: 'conversation', output: { reply: 'x', cards: [
    { type: 'weak_topics', payload: { topics: [{ topic: 'recursion', score: 35 }, { topic: 'graphs', score: 50 }] } },
  ] } };
  orch.attachProactiveTutoringOffer(response);
  assert.equal(response.output.suggestedAction.type, 'start_tutoring');
  assert.equal(response.output.suggestedAction.topic, 'recursion');
  assert.equal(response.output.suggestedAction.score, 35);
});

test('attachProactiveTutoringOffer: no-op when an action already exists', () => {
  const orch = load();
  const response = { mode: 'conversation', output: { reply: 'x', suggestedAction: { type: 'request_drill' }, cards: [
    { type: 'weak_topics', payload: { topics: [{ topic: 'recursion', score: 35 }] } },
  ] } };
  orch.attachProactiveTutoringOffer(response);
  assert.equal(response.output.suggestedAction.type, 'request_drill');
});
