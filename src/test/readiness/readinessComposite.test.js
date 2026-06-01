'use strict';
require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeComposite } = require('../../services/readiness/readinessService');
const { confidenceFrom } = require('../../services/readiness/competencyMasteryService');

const NOW = new Date('2026-06-01T00:00:00Z');

test('computeComposite weights competency mastery by competency.weight', () => {
  const objective = { objectiveType: 'upskilling', specifics: {}, analysis: { competencies: [
    { name: 'Data Structures', weight: 8, assessmentTypes: ['knowledge_recall'] },
    { name: 'Communication', weight: 2, assessmentTypes: ['situational_judgment'] },
  ] } };
  const knowledge = { topicMastery: [{ topic: 'data structures', score: 90, lastAssessedAt: NOW, quizzesTaken: 4 }] };
  const interviewSignal = { score: 40, count: 2, lastAt: NOW };
  const r = computeComposite({ objective, ctx: { coding: false }, knowledge, codingSignal: null, interviewSignal, behavioral: { modifier: 0 }, now: NOW });
  // weighted = (90*8 + 40*2)/10 = 80 ; +0 modifier
  assert.strictEqual(r.value, 80);
  assert.strictEqual(r.breakdown.length, 2);
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
});

test('computeComposite applies the bounded behavioral modifier and clamps 0..100', () => {
  const objective = { objectiveType: 'upskilling', specifics: {}, analysis: { competencies: [
    { name: 'X', weight: 5, assessmentTypes: ['knowledge_recall'] },
  ] } };
  const knowledge = { topicMastery: [{ topic: 'x', score: 98, lastAssessedAt: NOW, quizzesTaken: 4 }] };
  const r = computeComposite({ objective, ctx: { coding: false }, knowledge, codingSignal: null, interviewSignal: null, behavioral: { modifier: 5 }, now: NOW });
  assert.strictEqual(r.value, 100); // 98 + 5 -> clamp 100
});

test('computeComposite excludes unassessed competencies (value tracks measured; coverage lowers confidence)', () => {
  const objective = { objectiveType: 'upskilling', specifics: {}, analysis: { competencies: [
    { name: 'Algebra', weight: 5, assessmentTypes: ['knowledge_recall'] },
    { name: 'Geometry', weight: 5, assessmentTypes: ['knowledge_recall'] }, // no evidence
  ] } };
  const knowledge = { topicMastery: [{ topic: 'algebra', score: 60, lastAssessedAt: NOW, quizzesTaken: 4 }] };
  const r = computeComposite({ objective, ctx: { coding: false }, knowledge, codingSignal: null, interviewSignal: null, behavioral: { modifier: 0 }, now: NOW });
  // value = 60 (only Algebra counts), NOT (60+0)/2 = 30
  assert.strictEqual(r.value, 60);
  assert.strictEqual(r.coverage, 0.5); // 1 of 2 by weight
  assert.ok(r.confidence > 0 && r.confidence < 1);
  // breakdown still lists both, flagged assessed/unassessed
  assert.strictEqual(r.breakdown.length, 2);
  assert.strictEqual(r.breakdown.find(b => b.competency === 'Geometry').assessed, false);
});

test('computeComposite returns null when objective has no analysis', () => {
  const r = computeComposite({ objective: { analysis: null }, ctx: { coding: false }, knowledge: {}, now: NOW });
  assert.strictEqual(r, null);
});

// ── Confidence recalibration (2026-06-01) ──────────────────────────────────────

test('confidenceFrom: one fresh difficulty-graded assessment is blend-able, not 0.175', () => {
  // Was volume(0.25) × 1 × diff(0.7) = 0.175 (stuck below the 0.35 gate forever).
  assert.ok(confidenceFrom({ count: 1, recency: 1, hasDifficulty: true }) >= 0.45);
  // Curve climbs with volume; 3+ approaches full.
  assert.ok(confidenceFrom({ count: 3, recency: 1, hasDifficulty: true }) >= 0.8);
  // Stale evidence still decays.
  assert.ok(confidenceFrom({ count: 1, recency: 0.5, hasDifficulty: true }) < 0.35);
  assert.strictEqual(confidenceFrom({ count: 0 }), 0);
});

test('a single fresh diagnostic over a well-covered objective clears the 0.35 blend gate', () => {
  const objective = { objectiveType: 'upskilling', specifics: {}, analysis: { competencies: [
    { name: 'Algebra', weight: 5, assessmentTypes: ['knowledge_recall'] },
  ] } };
  const knowledge = { topicMastery: [{ topic: 'algebra', score: 70, lastAssessedAt: NOW, quizzesTaken: 1 }] };
  const r = computeComposite({ objective, ctx: { coding: false }, knowledge, codingSignal: null, interviewSignal: null, behavioral: { modifier: 0 }, now: NOW });
  assert.strictEqual(r.value, 70);
  assert.strictEqual(r.coverage, 1);
  assert.ok(r.confidence >= 0.35, `expected confidence >= 0.35, got ${r.confidence}`);
});

test('thin coverage still keeps confidence below the gate (legacy keeps serving)', () => {
  const objective = { objectiveType: 'upskilling', specifics: {}, analysis: { competencies: [
    { name: 'Algebra', weight: 1, assessmentTypes: ['knowledge_recall'] },
    { name: 'Geometry', weight: 9, assessmentTypes: ['knowledge_recall'] }, // heavy + unassessed
  ] } };
  const knowledge = { topicMastery: [{ topic: 'algebra', score: 80, lastAssessedAt: NOW, quizzesTaken: 1 }] };
  const r = computeComposite({ objective, ctx: { coding: false }, knowledge, codingSignal: null, interviewSignal: null, behavioral: { modifier: 0 }, now: NOW });
  assert.ok(r.coverage <= 0.1);
  assert.ok(r.confidence < 0.35, `expected confidence < 0.35, got ${r.confidence}`);
});
