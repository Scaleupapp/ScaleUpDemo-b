// src/test/v2/compassOrchestrator.tutorTopic.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const ANTHROPIC = path.resolve(__dirname, '../../config/anthropic.js');
const REDIS = path.resolve(__dirname, '../../config/redis.js');
const PROGRESS = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const CONV = path.resolve(__dirname, '../../models/CompassConversation.js');
// buildUserContext stubs (from compassOrchestrator.context.test.js)
const READINESS = path.resolve(__dirname, '../../services/readiness/readinessService.js');
const USER = path.resolve(__dirname, '../../models/User.js');
const UO = path.resolve(__dirname, '../../models/UserObjective.js');
const PLAN = path.resolve(__dirname, '../../models/Plan.js');
const KP = path.resolve(__dirname, '../../models/KnowledgeProfile.js');
const USERCTX = path.resolve(__dirname, '../../services/userContextService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }
function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async () => 0, expire: async () => 1, get: async () => '0' }; }

test('tutorTopic: explains the topic grounded in misconceptions + offers a check', async () => {
  // buildUserContext stubs
  stub(USER, { findById: () => ({ select: () => ({ lean: async () => ({ firstName: 'Nirpeksh' }) }) }) });
  stub(UO, { findOne: () => ({ lean: async () => null }) });
  stub(PLAN, { findOne: () => ({ lean: async () => null }) });
  stub(KP, { findOne: () => ({ lean: async () => ({ topicMastery: [] }) }) });
  stub(USERCTX, { getUserContext: async () => null });
  stub(READINESS, { getServedReadiness: async () => null });

  stub(REDIS, fakeRedis());
  stub(CONV, { findOne: () => ({ sort: () => null }), create: async () => ({ messages: [], messageCount: 0, lastMessageAt: new Date(), title: 'New conversation', save: async () => {} }) });
  stub(PROGRESS, { getTopicDetail: async () => ({ topic: 'recursion', score: 35, level: 'beginner', trend: 'declining', misconceptions: [{ tag: 'base_case', explanation: 'forgets the base case' }], dueConcepts: [] }) });
  stub(ANTHROPIC, { messages: { create: async ({ system }) => {
    assert.match(system, /recursion/);
    assert.match(system, /base_case|forgets the base case/);
    return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Every recursion needs a base case. Example: factorial...' }] };
  } } });
  const orch = load();
  const res = await orch.handle({ userId: 'u1', mode: 'tutor_topic', payload: { topic: 'recursion' } });
  assert.match(res.output.reply, /base case/i);
  assert.equal(res.output.cards[0].type, 'topic_detail');
  assert.equal(res.output.suggestedAction.type, 'start_check_quiz');
  assert.equal(res.output.suggestedAction.topic, 'recursion');
  assert.equal(res.output.suggestedAction.before_score, 35);
});
