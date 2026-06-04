// src/test/v2/compassOrchestrator.tutorResult.test.js
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
const QA = path.resolve(__dirname, '../../models/QuizAttempt.js');
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

test('tutorResult: returns check score, mastery delta, and a next-topic offer', async () => {
  // buildUserContext stubs
  stub(USER, { findById: () => ({ select: () => ({ lean: async () => ({ firstName: 'Nirpeksh' }) }) }) });
  stub(UO, { findOne: () => ({ lean: async () => null }) });
  stub(PLAN, { findOne: () => ({ lean: async () => null }) });
  stub(KP, { findOne: () => ({ lean: async () => ({ topicMastery: [] }) }) });
  stub(USERCTX, { getUserContext: async () => null });
  stub(READINESS, { getServedReadiness: async () => null });

  stub(REDIS, fakeRedis());
  stub(CONV, { findOne: () => ({ sort: () => null }), create: async () => ({ messages: [], messageCount: 0, lastMessageAt: new Date(), title: 'New conversation', save: async () => {} }) });
  stub(QA, { findOne: () => ({ lean: async () => ({ score: { percentage: 75 } }) }) });
  stub(PROGRESS, {
    getTopicDetail: async () => ({ topic: 'recursion', score: 52 }),
    listWeakTopics: async () => [{ topic: 'recursion', score: 52 }, { topic: 'graphs', score: 41 }],
  });
  stub(ANTHROPIC, { messages: { create: async () => ({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Nice jump on recursion — revisit recursion vs iteration.' }] }) } });
  const orch = load();
  const res = await orch.handle({ userId: 'u1', mode: 'tutor_result', payload: { topic: 'recursion', attemptId: 'a1', beforeScore: 35 } });
  const card = res.output.cards.find((c) => c.type === 'tutoring_result');
  assert.equal(card.payload.checkScore, 75);
  assert.equal(card.payload.beforeScore, 35);
  assert.equal(card.payload.afterScore, 52);
  assert.equal(card.payload.delta, 17);
  assert.equal(res.output.suggestedAction.type, 'start_tutoring');
  assert.equal(res.output.suggestedAction.topic, 'graphs'); // next weak topic (not the one just done)
});
