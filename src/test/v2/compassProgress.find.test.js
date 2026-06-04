// src/test/v2/compassProgress.find.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SVC = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const QUIZ = path.resolve(__dirname, '../../models/Quiz.js');
const QA = path.resolve(__dirname, '../../models/QuizAttempt.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[SVC]; return require(SVC); }

test('findActivity(quiz, "product management"): finds the matching quiz attempt', async () => {
  stub(QUIZ, { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ _id: 'q1', topic: 'product management' }] }) }) }) });
  stub(QA, { findOne: () => ({ sort: () => ({ lean: async () => ({ quizId: 'q1', completedAt: new Date('2026-05-01'), score: { percentage: 64 }, topicBreakdown: [], analysis: {} }) }) }) });
  const svc = load();
  const out = await svc.findActivity('u1', 'quiz', 'product management');
  assert.equal(out.activityType, 'quiz');
  assert.equal(out.overallScore, 64);
});

test('findActivity: returns null when no match', async () => {
  stub(QUIZ, { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
  const svc = load();
  assert.equal(await svc.findActivity('u1', 'quiz', 'nonexistent'), null);
});
