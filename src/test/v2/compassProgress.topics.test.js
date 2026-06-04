// src/test/v2/compassProgress.topics.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SVC = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const KP = path.resolve(__dirname, '../../models/KnowledgeProfile.js');
const USERCTX = path.resolve(__dirname, '../../services/userContextService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[SVC]; return require(SVC); }

test('listWeakTopics: returns weak topics sorted ascending by score', async () => {
  stub(KP, { findOne: () => ({ lean: async () => ({ topicMastery: [
    { topic: 'arrays', score: 82, trend: 'improving', quizzesTaken: 3 },
    { topic: 'recursion', score: 35, trend: 'declining', quizzesTaken: 2 },
    { topic: 'graphs', score: 50, trend: 'stable', quizzesTaken: 1 },
  ] }) }) });
  const svc = load();
  const out = await svc.listWeakTopics('u1', 5);
  assert.equal(out[0].topic, 'recursion');
  assert.equal(out.length, 2);   // arrays excluded (>=60)
});

test('getTopicDetail: merges mastery + misconceptions + due concepts', async () => {
  stub(KP, { findOne: () => ({ lean: async () => ({ topicMastery: [
    { topic: 'recursion', score: 35, level: 'beginner', trend: 'declining', quizzesTaken: 2, scoreHistory: [{ score: 30, date: new Date('2026-04-01') }] },
  ] }) }) });
  stub(USERCTX, { getUserContext: async () => ({ misconceptions: [{ tag: 'base_case', explanation: 'forgets base case', topics: ['recursion'] }], dueForReview: [{ concept: 'recursion-depth', topic: 'recursion' }] }) });
  const svc = load();
  const out = await svc.getTopicDetail('u1', 'recursion');
  assert.equal(out.topic, 'recursion');
  assert.equal(out.score, 35);
  assert.equal(out.misconceptions.length, 1);
});
