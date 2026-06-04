// src/test/v2/compassProgress.latest.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SVC = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const IS = path.resolve(__dirname, '../../models/InterviewSession.js');
const CAP = path.resolve(__dirname, '../../coding/models/capstoneSession.model.js');
const BUNDLE = path.resolve(__dirname, '../../coding/models/artifactBundle.model.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[SVC]; return require(SVC); }

test('getLatestResult(interview): maps evaluation to dimensions + highlights', async () => {
  stub(IS, { findOne: () => ({ sort: () => ({ lean: async () => ({
    interviewType: 'placement_technical', completedAt: new Date('2026-05-01'),
    evaluation: { overallScore: 72, communication: { score: 7, feedback: 'clear' }, content: { score: 6, feedback: 'ok' },
      structure: { score: 8, feedback: 'good' }, confidence: { score: 5, feedback: 'nervous' },
      overallStrengths: ['structure'], overallImprovements: ['depth'] },
  }) }) }) });
  const svc = load();
  const out = await svc.getLatestResult('u1', 'interview');
  assert.equal(out.activityType, 'interview');
  assert.equal(out.overallScore, 72);
  assert.equal(out.dimensions.length, 4);
  assert.equal(out.highlights.improvements[0], 'depth');
});

test('getLatestResult(coding): maps capstone 6 dimensions', async () => {
  stub(CAP, { findOne: () => ({ sort: () => ({ lean: async () => ({
    bundle_id: 'b1', graded_at: new Date('2026-05-02'),
    result: { overall_score: 68, dimension_scores: { correctness: 70, code_quality: 65, ai_pair_effectiveness: 80, verification_discipline: 60, decomposition: 66, reflection_quality: 64 },
      dimension_feedback: { correctness: { why: 'mostly', to_improve: 'edge cases' } }, strengths: ['tests'], gaps: ['edge cases'] },
  }) }) }) });
  stub(BUNDLE, { findById: () => ({ lean: async () => ({ brief: 'Build a rate limiter\nmore' }) }) });
  const svc = load();
  const out = await svc.getLatestResult('u1', 'coding');
  assert.equal(out.activityType, 'coding');
  assert.equal(out.overallScore, 68);
  assert.equal(out.dimensions.length, 6);
  assert.equal(out.title, 'Build a rate limiter');
});

test('getLatestResult: returns null when nothing found', async () => {
  stub(IS, { findOne: () => ({ sort: () => ({ lean: async () => null }) }) });
  const svc = load();
  assert.equal(await svc.getLatestResult('u1', 'interview'), null);
});
