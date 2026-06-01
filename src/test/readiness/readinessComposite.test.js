'use strict';
require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeComposite } = require('../../services/readiness/readinessService');

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

test('computeComposite returns null when objective has no analysis', () => {
  const r = computeComposite({ objective: { analysis: null }, ctx: { coding: false }, knowledge: {}, now: NOW });
  assert.strictEqual(r, null);
});
