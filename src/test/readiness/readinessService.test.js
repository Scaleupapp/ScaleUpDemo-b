'use strict';
require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assembleLegacy, computeReadinessFromKnowledge } = require('../../services/readiness/readinessService');

test('assembleLegacy: plan.readinessScore wins the waterfall', () => {
  const r = assembleLegacy({ plan: { readinessScore: 62 }, journey: { readinessScore: 40 }, knowledge: { overallScore: 30 } });
  assert.strictEqual(r.value, 62);
  assert.strictEqual(r.source, 'plan');
});

test('assembleLegacy: falls through to journey then knowledge then floor', () => {
  assert.strictEqual(assembleLegacy({ journey: { readinessScore: 41 } }).value, 41);
  assert.strictEqual(assembleLegacy({ knowledge: { overallScore: 33 } }).value, 33);
  assert.strictEqual(assembleLegacy({}).value, 0);
});

test('assembleLegacy: coding blend is bounded and ramps in only after 5 attempts', () => {
  // base 60, coding value 80, weight 0.10 (>=10 attempts) -> 60*0.9 + 80*0.1 = 62
  const blended = assembleLegacy({ knowledge: { overallScore: 60 }, codingComponent: { value: 80, weight: 0.10, attempt_count: 12 } });
  assert.strictEqual(blended.value, 62);
  // weight 0 -> unchanged
  const none = assembleLegacy({ knowledge: { overallScore: 60 }, codingComponent: { value: 80, weight: 0, attempt_count: 3 } });
  assert.strictEqual(none.value, 60);
});

test('computeReadinessFromKnowledge mirrors the overview helper', () => {
  assert.strictEqual(computeReadinessFromKnowledge({ overallScore: 47 }), 47);
  assert.strictEqual(computeReadinessFromKnowledge(null), null);
});

test('chooseServed: flag off OR no shadow -> legacy', () => {
  const { chooseServed } = require('../../services/readiness/readinessService');
  assert.deepStrictEqual(chooseServed({ legacyValue: 60, shadow: { value: 40, confidence: 0.9 }, flagOn: false }), { value: 60, source: 'legacy' });
  assert.deepStrictEqual(chooseServed({ legacyValue: 50, shadow: null, flagOn: true }), { value: 50, source: 'legacy' });
});

test('chooseServed: low confidence keeps legacy (no cold-start cliff)', () => {
  const { chooseServed } = require('../../services/readiness/readinessService');
  const r = chooseServed({ legacyValue: 65, shadow: { value: 42, confidence: 0.2 }, flagOn: true });
  assert.strictEqual(r.value, 65);
  assert.strictEqual(r.source, 'legacy_lowconf');
});

test('chooseServed: high confidence serves the composite', () => {
  const { chooseServed } = require('../../services/readiness/readinessService');
  const r = chooseServed({ legacyValue: 65, shadow: { value: 78, confidence: 0.8 }, flagOn: true });
  assert.strictEqual(r.value, 78);
  assert.strictEqual(r.source, 'composite');
});

test('chooseServed: medium confidence blends legacy and composite', () => {
  const { chooseServed } = require('../../services/readiness/readinessService');
  // conf 0.525 -> w=(0.525-0.35)/(0.7-0.35)=0.5 -> 60*0.5 + 80*0.5 = 70
  const r = chooseServed({ legacyValue: 60, shadow: { value: 80, confidence: 0.525 }, flagOn: true });
  assert.strictEqual(r.value, 70);
  assert.strictEqual(r.source, 'blend');
});

test('persistSnapshot writes a ReadinessSnapshot and never throws', async () => {
  const ReadinessSnapshot = require('../../models/ReadinessSnapshot');
  const created = [];
  const orig = ReadinessSnapshot.create;
  ReadinessSnapshot.create = async (doc) => { created.push(doc); return doc; };
  const svc = require('../../services/readiness/readinessService');
  await svc.persistSnapshot({ userId: 'u1', objectiveId: 'o1', value: 62, source: 'knowledge' });
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].value, 62);
  // never throws even if create blows up
  ReadinessSnapshot.create = async () => { throw new Error('db down'); };
  await svc.persistSnapshot({ userId: 'u1', value: 50, source: 'floor' }); // should resolve, not reject
  ReadinessSnapshot.create = orig;
});
