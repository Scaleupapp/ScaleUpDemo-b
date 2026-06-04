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
const QUIZ_ATTEMPT = path.resolve(__dirname, '../../models/QuizAttempt.js');
const INTERVIEW_SESSION = path.resolve(__dirname, '../../models/InterviewSession.js');
const CAPSTONE = path.resolve(__dirname, '../../coding/models/capstoneSession.model.js');
const DRILL = path.resolve(__dirname, '../../coding/models/drillAttempt.model.js');
const CHALLENGE = path.resolve(__dirname, '../../models/ChallengeAttempt.js');
const CONTENT_PROGRESS = path.resolve(__dirname, '../../models/ContentProgress.js');
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

test('listRecentActivity: merges all six types, sorts desc by date, respects type filter', async () => {
  // Each stub returns one record so we can assert all types appear in the merge.
  stub(QUIZ_ATTEMPT, {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ score: { percentage: 80 }, completedAt: new Date('2026-05-10') }] }) }) }),
  });
  stub(INTERVIEW_SESSION, {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ interviewType: 'behavioural', evaluation: { overallScore: 72 }, completedAt: new Date('2026-05-08') }] }) }) }),
  });
  stub(CAPSTONE, {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ result: { overall_score: 85 }, graded_at: new Date('2026-05-12') }] }) }) }),
  });
  stub(DRILL, {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ grade: { overall_score: 70 }, submitted_at: new Date('2026-05-07') }] }) }) }),
  });
  stub(CHALLENGE, {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ rawScore: 90, completedAt: new Date('2026-05-15') }] }) }) }),
  });
  stub(CONTENT_PROGRESS, {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ percentageCompleted: 100, completedAt: new Date('2026-05-03') }] }) }) }),
  });
  // Also stub dependencies that load() pulls in transitively
  stub(KP, { findOne: () => ({ lean: async () => null }) });
  stub(USERCTX, { getUserContext: async () => null });

  const svc = load();
  const out = await svc.listRecentActivity('u1', 20);

  // All six types should be present
  const types = out.map((x) => x.type);
  assert.ok(types.includes('quiz'), 'should include quiz');
  assert.ok(types.includes('interview'), 'should include interview');
  assert.ok(types.includes('coding'), 'should include coding');
  assert.ok(types.includes('competition'), 'should include competition');
  assert.ok(types.includes('content'), 'should include content');

  // Sorted descending by date (first item should be the challenge at 2026-05-15)
  assert.equal(out[0].type, 'competition');
  assert.equal(out[0].date, '2026-05-15');

  // type filter: only 'coding' items (capstone + drill)
  const codingOnly = await svc.listRecentActivity('u1', 20, 'coding');
  assert.ok(codingOnly.every((x) => x.type === 'coding'));
  assert.equal(codingOnly.length, 2);
  assert.ok(codingOnly.some((x) => x.title === 'Coding capstone'));
  assert.ok(codingOnly.some((x) => x.title === 'Coding drill'));
});
