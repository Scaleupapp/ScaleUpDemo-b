// src/test/v2/compassProgress.snapshot.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SVC = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
function stub(p, exports) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports }; }
function load() { delete require.cache[SVC]; return require(SVC); }

const READINESS = path.resolve(__dirname, '../../services/readiness/readinessService.js');
const USERCTX  = path.resolve(__dirname, '../../services/userContextService.js');
const KP       = path.resolve(__dirname, '../../models/KnowledgeProfile.js');
const PLAN     = path.resolve(__dirname, '../../models/Plan.js');
const QA       = path.resolve(__dirname, '../../models/QuizAttempt.js');
const IS       = path.resolve(__dirname, '../../models/InterviewSession.js');
const CP       = path.resolve(__dirname, '../../models/ContentProgress.js');
const COMPPROF = path.resolve(__dirname, '../../models/CompetitionProfile.js');

function stubAll() {
  stub(READINESS, { getServedReadiness: async () => ({ value: 70, target: 80, source: 'knowledge', trend: 'stable', breakdown: null, draggers: [{ name: 'recursion', score: 40 }] }) });
  stub(USERCTX, { getUserContext: async () => ({ misconceptions: [{ tag: 'off_by_one', explanation: 'boundary error' }], dueForReview: [{ concept: 'closures' }], recentTopicsTouched: ['arrays'], recentAITutor: { topicsCovered: [], openQuestions: [] } }) });
  stub(KP, { findOne: () => ({ lean: async () => ({ topicMastery: [
    { topic: 'arrays', score: 82, trend: 'improving', quizzesTaken: 3 },
    { topic: 'recursion', score: 40, trend: 'declining', quizzesTaken: 2 },
  ] }) }) });
  stub(PLAN, { findOne: () => ({ lean: async () => ({ currentWeek: 2, totalWeeks: 6, tasks: [] }) }) });
  stub(QA, { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ score: { percentage: 80 } }, { score: { percentage: 60 } }] }) }) }) });
  stub(IS, { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
  stub(CP, { countDocuments: async () => 4, find: () => ({ lean: async () => [{ totalTimeSpent: 600 }] }) });
  stub(COMPPROF, { findOne: () => ({ lean: async () => ({ currentChallengeStreak: 3, totalChallengesCompleted: 5 }) }) });
}

test('getSnapshot: composes readiness, mastery, pulse and signals', async () => {
  stubAll();
  const svc = load();
  const snap = await svc.getSnapshot('u1');
  assert.equal(snap.readiness.value, 70);
  assert.equal(snap.readiness.target, 80);
  assert.equal(snap.mastery.strong[0].topic, 'arrays');
  assert.equal(snap.mastery.weak[0].topic, 'recursion');
  assert.equal(snap.pulse.quizzes.count, 2);
  assert.equal(snap.pulse.quizzes.avgPercent, 70);
  assert.equal(snap.signals.plan.week, 2);
});

test('getSnapshot: never throws when a source fails — omits that slice', async () => {
  stubAll();
  stub(READINESS, { getServedReadiness: async () => { throw new Error('boom'); } });
  const svc = load();
  const snap = await svc.getSnapshot('u1');
  assert.equal(snap.readiness, null);
  assert.ok(snap.mastery);
});

test('renderSnapshot: produces non-empty prompt text from a snapshot', async () => {
  stubAll();
  const svc = load();
  const snap = await svc.getSnapshot('u1');
  const text = svc.renderSnapshot(snap);
  assert.match(text, /readiness/i);
  assert.match(text, /recursion/);
});
