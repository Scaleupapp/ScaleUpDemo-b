'use strict';
/**
 * Workstream A — GET /api/v2/plan/today `readinessSource` tag.
 *
 * Unit tests for the deriveReadiness() waterfall helper. Verifies the numeric
 * result is identical to the original `??` chain AND that each branch is tagged
 * so the client can lock the ring on 'default' (no real evidence).
 */
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');

// plan.js requires config/queue at load, which opens a Redis connection.
// Stub it before requiring the route (same pattern as diagnosticService tests).
const queuePath = require.resolve('../../config/queue');
require.cache[queuePath] = {
  exports: { planGenerationQueue: { add: async () => ({}) } },
  loaded: true, id: queuePath,
};

const planRouter = require('../../routes/v2/plan');
const { deriveReadiness } = planRouter._helpers;

test('deriveReadiness: snapshot wins when value is a number', () => {
  const r = deriveReadiness({ value: 55 }, { results: { sql: { score: 10 } } }, { topicProfiles: { a: { masteryLevel: 90 } } });
  assert.deepStrictEqual(r, { currentReadiness: 55, readinessSource: 'snapshot' });
});

test('deriveReadiness: snapshot value 0 is respected (not treated as missing)', () => {
  const r = deriveReadiness({ value: 0 }, { results: { sql: { score: 80 } } }, null);
  assert.deepStrictEqual(r, { currentReadiness: 0, readinessSource: 'snapshot' });
});

test('deriveReadiness: falls to diagnostic baseline when snapshot missing/non-number', () => {
  const attempt = { results: { sql: { score: 40 }, dsa: { score: 60 } } }; // avg 50
  assert.deepStrictEqual(deriveReadiness(null, attempt, null), { currentReadiness: 50, readinessSource: 'diagnostic' });
  // latestSnap present but value not a number → still falls through to diagnostic
  assert.deepStrictEqual(deriveReadiness({ value: null }, attempt, null), { currentReadiness: 50, readinessSource: 'diagnostic' });
});

test('deriveReadiness: falls to knowledge profile when no snapshot and no diagnostic scores', () => {
  const knowledge = { topicProfiles: { a: { masteryLevel: 30 }, b: { masteryLevel: 40 } } }; // avg 35
  assert.deepStrictEqual(deriveReadiness(null, null, knowledge), { currentReadiness: 35, readinessSource: 'knowledge' });
  // An attempt with no scorable results also falls through to knowledge.
  assert.deepStrictEqual(deriveReadiness(null, { results: {} }, knowledge), { currentReadiness: 35, readinessSource: 'knowledge' });
});

test('deriveReadiness: default (30) tagged distinctly from a real 30 from knowledge', () => {
  assert.deepStrictEqual(deriveReadiness(null, null, null), { currentReadiness: 30, readinessSource: 'default' });
  // A knowledge average of exactly 30 must NOT be mislabeled 'default'.
  const knowledge30 = { topicProfiles: { a: { masteryLevel: 30 } } };
  assert.deepStrictEqual(deriveReadiness(null, null, knowledge30), { currentReadiness: 30, readinessSource: 'knowledge' });
});

test('deriveReadiness: empty knowledge profiles → default', () => {
  assert.deepStrictEqual(deriveReadiness(null, null, { topicProfiles: {} }), { currentReadiness: 30, readinessSource: 'default' });
});
