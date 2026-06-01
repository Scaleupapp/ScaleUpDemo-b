'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../../services/readiness/competencyMasteryService');

const NOW = new Date('2026-06-01T00:00:00Z');

test('buildCodingSignal aggregates capstones + drills + mastery axes', () => {
  const sig = svc.buildCodingSignal({
    capstones: [{ result: { overall_score: 80 }, graded_at: new Date('2026-05-30T00:00:00Z') }],
    drills: [{ grade: { overall_score: 70 }, submitted_at: new Date('2026-05-29T00:00:00Z') }],
    mastery: { axes: { prompting: 60, verification: 70, decomposition: 50, refactoring: 40 } },
    now: NOW,
  });
  assert.ok(sig.score >= 0 && sig.score <= 100);
  assert.strictEqual(sig.count, 2);          // 1 capstone + 1 drill
  assert.ok(sig.lastAt instanceof Date);
});

test('buildCodingSignal falls back to mastery axes when no graded events', () => {
  const sig = svc.buildCodingSignal({ capstones: [], drills: [], mastery: { axes: { prompting: 60, verification: 60, decomposition: 60, refactoring: 60 } }, now: NOW });
  assert.strictEqual(sig.count, 0);
  assert.strictEqual(sig.score, 60);
  assert.strictEqual(sig.hasDifficulty, false);
});

test('buildInterviewSignal averages recent interview scores', () => {
  const sig = svc.buildInterviewSignal({
    interviews: [
      { evaluation: { overallScore: 60 }, completedAt: new Date('2026-05-20T00:00:00Z') },
      { evaluation: { overallScore: 80 }, completedAt: new Date('2026-05-31T00:00:00Z') },
    ],
    now: NOW,
  });
  assert.strictEqual(sig.count, 2);
  assert.ok(sig.score >= 60 && sig.score <= 80);
});

test('buildBehavioralSignal returns a bounded modifier in [-5, 5]', () => {
  const hot = svc.buildBehavioralSignal({ streak: 30, contentCompleted: 20, activeDays7: 7 });
  const cold = svc.buildBehavioralSignal({ streak: 0, contentCompleted: 0, activeDays7: 0 });
  assert.ok(hot.modifier <= 5 && hot.modifier >= -5);
  assert.ok(cold.modifier <= 5 && cold.modifier >= -5);
  assert.ok(hot.modifier >= cold.modifier);
});

test('recencyFactor decays from 1.0 toward a 0.5 floor over 90 days', () => {
  assert.strictEqual(svc.recencyFactor(NOW, NOW), 1);
  const d45 = svc.recencyFactor(new Date(NOW.getTime() - 45 * 24 * 3600 * 1000), NOW);
  assert.ok(d45 > 0.5 && d45 < 1);
  const d200 = svc.recencyFactor(new Date(NOW.getTime() - 200 * 24 * 3600 * 1000), NOW);
  assert.strictEqual(d200, 0.5);
  assert.strictEqual(svc.recencyFactor(null, NOW), 0.5); // unknown date -> floor
});

test('confidenceFrom rises with evidence count + recency + difficulty', () => {
  const low = svc.confidenceFrom({ count: 0, recency: 0.5, hasDifficulty: false });
  const high = svc.confidenceFrom({ count: 5, recency: 1, hasDifficulty: true });
  assert.ok(low >= 0 && low <= 1);
  assert.ok(high > low);
  assert.ok(high <= 1);
});

test('computeCompetencyMastery: quiz competency reads topicMastery by name', () => {
  const knowledge = { topicMastery: [{ topic: 'data structures', score: 72, lastAssessedAt: NOW, quizzesTaken: 3 }] };
  const out = svc.computeCompetencyMastery({
    competency: { name: 'Data Structures', assessmentTypes: ['knowledge_recall'] },
    ctx: { coding: true }, knowledge, codingSignal: null, interviewSignal: null, now: NOW,
  });
  assert.strictEqual(out.primitive, 'quiz');
  assert.ok(Math.abs(out.score - 72) <= 1); // recency factor = 1 at NOW
  assert.ok(out.confidence > 0);
});

test('computeCompetencyMastery: applied competency in coding objective uses codingSignal', () => {
  const out = svc.computeCompetencyMastery({
    competency: { name: 'API Design', assessmentTypes: ['applied_scenario'] },
    ctx: { coding: true }, knowledge: { topicMastery: [] },
    codingSignal: { score: 85, count: 2, lastAt: NOW, hasDifficulty: true }, interviewSignal: null, now: NOW,
  });
  assert.strictEqual(out.primitive, 'coding');
  assert.ok(out.score >= 80);
});

test('computeCompetencyMastery: per-competency quiz score WINS over coding/interview aggregate (PM-objective bug)', () => {
  // A Product-Management competency wrongly routed to coding (ctx.coding=true via
  // a soft-keyword eligibility false-positive) must still use its real quiz score,
  // not the smeared coding aggregate.
  const knowledge = { topicMastery: [{ topic: 'product metrics & analytics', score: 35, lastAssessedAt: NOW, quizzesTaken: 2 }] };
  const out = svc.computeCompetencyMastery({
    competency: { name: 'Product Metrics & Analytics', assessmentTypes: ['framework_application'] },
    ctx: { coding: true }, knowledge,
    codingSignal: { score: 15, count: 3, lastAt: NOW, hasDifficulty: true }, interviewSignal: null, now: NOW,
  });
  assert.strictEqual(out.primitive, 'quiz'); // NOT coding
  assert.ok(Math.abs(out.score - 35) <= 1);
});

test('computeCompetencyMastery: no evidence -> score 0, confidence 0', () => {
  const out = svc.computeCompetencyMastery({
    competency: { name: 'Nothing', assessmentTypes: ['knowledge_recall'] },
    ctx: { coding: false }, knowledge: { topicMastery: [] }, codingSignal: null, interviewSignal: null, now: NOW,
  });
  assert.strictEqual(out.score, 0);
  assert.strictEqual(out.confidence, 0);
});
