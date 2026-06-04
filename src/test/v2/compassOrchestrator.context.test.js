// src/test/v2/compassOrchestrator.context.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const READINESS = path.resolve(__dirname, '../../services/readiness/readinessService.js');
const USER = path.resolve(__dirname, '../../models/User.js');
const UO = path.resolve(__dirname, '../../models/UserObjective.js');
const PLAN = path.resolve(__dirname, '../../models/Plan.js');
const KP = path.resolve(__dirname, '../../models/KnowledgeProfile.js');
const USERCTX = path.resolve(__dirname, '../../services/userContextService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }

test('buildUserContext: reads mastery from topicMastery and readiness from getServedReadiness', async () => {
  stub(USER, { findById: () => ({ select: () => ({ lean: async () => ({ firstName: 'Nirpeksh' }) }) }) });
  stub(UO, { findOne: () => ({ lean: async () => null }) });
  stub(PLAN, { findOne: () => ({ lean: async () => ({ currentWeek: 2, totalWeeks: 6, tasks: [] }) }) });
  stub(KP, { findOne: () => ({ lean: async () => ({ topicMastery: [
    { topic: 'arrays', score: 82, trend: 'improving', quizzesTaken: 3 },
    { topic: 'recursion', score: 35, trend: 'declining', quizzesTaken: 2 },
  ] }) }) });
  stub(USERCTX, { getUserContext: async () => null });
  stub(READINESS, { getServedReadiness: async () => ({ value: 70, target: 80, source: 'knowledge', trend: 'stable', draggers: [] }) });

  const orch = load();
  const ctx = await orch.buildUserContext('u1');
  assert.equal(ctx.readiness.value, 70);
  assert.equal(ctx.knowledge.strongTopics[0].topic, 'arrays');
  assert.equal(ctx.knowledge.weakTopics[0].topic, 'recursion');
});
