'use strict';
/**
 * Unit tests for the computeMaxTokens clamp helper.
 *
 * PRODUCTION BUG this guards against: institutional MCQ authoring requests a
 * pool of N questions with tokensPerQuestion scaled by complexity (up to 800
 * for case-study/applied-scenario types). For N=30, tokensPerQuestion=700,
 * the naive `Math.max(4096, N * tokensPerQuestion)` computes 21,000 —
 * above gpt-4o's 16,384-token output cap. OpenAI doesn't truncate an
 * over-cap request; it rejects the ENTIRE call with a 400, so generation
 * silently returned zero questions in production (totalGenerated: 0,
 * rounds: 0). computeMaxTokens clamps to the cap; the existing continuation
 * loop in generateQuiz backfills whatever the clamp cost.
 *
 * All heavy deps (Redis queue, OpenAI, Mongoose models) are stubbed via
 * require.cache BEFORE requiring the service, matching the pattern used in
 * src/test/quizGeneration.gate1.test.js — this test only needs the module to
 * load, not to actually call OpenAI or touch a DB.
 */
const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { exports, loaded: true, id: resolved };
}

stub('../config/openai', { chat: { completions: { create: async () => ({ choices: [] }) } } });
stub('../config/queue', { notificationQueue: { add: async () => ({}) } });
stub('../models/Content', { find: async () => [] });
stub('../models/QuizTrigger', { findByIdAndUpdate: async () => ({}) });
stub('../models/KnowledgeProfile', { findOne: async () => null });
stub('../models/UserObjective', { findOne: async () => null, findById: async () => null });
stub('../models/Quiz', { create: async (doc) => ({ _id: 'quiz1', ...doc }) });
stub('../models/QuizAttempt', { find: () => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }) }) });
stub('../models/ExternalContentTouch', { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
stub('../models/ExternalContentSnapshot', { find: () => ({ select: () => ({ lean: async () => [] }) }) });
stub('../services/userContextService', { getUserContext: async () => ({}), summarize: () => '' });

const quizGenerationService = require('./quizGenerationService');
const { computeMaxTokens } = quizGenerationService;

test('computeMaxTokens: under the cap passes through unchanged', () => {
  // 10 questions * 500 tokens/question = 5000, well under any reasonable cap.
  assert.strictEqual(computeMaxTokens(10, 500, 16384), 5000);
});

test('computeMaxTokens: over the cap clamps to the cap (the production bug)', () => {
  // 30 questions * 700 tokens/question (competency-aware pool) = 21000 — the
  // exact production scenario that made OpenAI reject the call outright.
  assert.strictEqual(computeMaxTokens(30, 700, 16384), 16384);
});

test('computeMaxTokens: floor of 4096 is respected for tiny requests', () => {
  // 2 questions * 500 = 1000, below the 4096 floor.
  assert.strictEqual(computeMaxTokens(2, 500, 16384), 4096);
});

test('computeMaxTokens: cap defaults to OPENAI_MAX_OUTPUT_TOKENS when omitted', () => {
  const { OPENAI_MAX_OUTPUT_TOKENS } = require('../config/openaiModels');
  assert.strictEqual(computeMaxTokens(100, 700), OPENAI_MAX_OUTPUT_TOKENS);
});

test('computeMaxTokens: exactly at the cap is not altered', () => {
  assert.strictEqual(computeMaxTokens(16, 1024, 16384), 16384);
});
