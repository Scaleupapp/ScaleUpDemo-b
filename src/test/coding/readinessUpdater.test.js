'use strict';

/**
 * Unit tests for src/coding/services/readinessUpdater.js
 *
 * MetaSkillMastery.findOne is stubbed — no DB connection required.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Model stub — patched before the service is loaded ────────────────────────

const models = require('../../coding/models');

let stubFindOne = null; // null = no doc; object = doc fields

// Return a Mongoose-query-like object: findOne(...) returns a thenable with .lean()
models.MetaSkillMastery.findOne = (_query) => {
  const plain = stubFindOne === null
    ? null
    : { ...stubFindOne, axes: { ...stubFindOne.axes } };
  // Mimic the Mongoose query chain: supports both await findOne() and findOne().lean()
  const q = {
    lean() { return Promise.resolve(plain); },
    then(resolve, reject) { return Promise.resolve(plain).then(resolve, reject); },
  };
  return q;
};

// ── Module under test — loaded AFTER stubs ────────────────────────────────────

const {
  getMetaSkillComponent,
  getMetaSkillWeight,
  metaSkillValue,
  TARGET_WEIGHT,
  MIN_ATTEMPTS_FOR_RAMP,
  FULL_RAMP_ATTEMPTS,
} = require('../../coding/services/readinessUpdater');

// ─────────────────────────────────────────────────────────────────────────────
// Helper: reset test state
// ─────────────────────────────────────────────────────────────────────────────
function reset() {
  stubFindOne = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. getMetaSkillWeight — pure function tests
// ─────────────────────────────────────────────────────────────────────────────

test('getMetaSkillWeight(0) → 0 (no attempts)', () => {
  assert.strictEqual(getMetaSkillWeight(0), 0);
});

test('getMetaSkillWeight(4) → 0 (still below ramp threshold)', () => {
  assert.strictEqual(getMetaSkillWeight(4), 0);
});

test('getMetaSkillWeight(5) → 0 (ramp starts AT 5 — at the boundary, progress=0)', () => {
  assert.strictEqual(getMetaSkillWeight(5), 0);
});

test('getMetaSkillWeight(7) → 0.04 (linear ramp: 0.10 * (7-5)/(10-5))', () => {
  const result = getMetaSkillWeight(7);
  // 0.10 * 2/5 = 0.04 — use tolerance for floating-point arithmetic
  assert.ok(Math.abs(result - 0.04) < 0.0001, `expected ~0.04 but got ${result}`);
});

test('getMetaSkillWeight(10) → 0.10 (full ramp reached)', () => {
  assert.strictEqual(getMetaSkillWeight(10), TARGET_WEIGHT);
  assert.strictEqual(getMetaSkillWeight(10), 0.10);
});

test('getMetaSkillWeight(100) → 0.10 (capped at TARGET_WEIGHT)', () => {
  assert.strictEqual(getMetaSkillWeight(100), TARGET_WEIGHT);
  assert.strictEqual(getMetaSkillWeight(100), 0.10);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. metaSkillValue — pure function tests
// ─────────────────────────────────────────────────────────────────────────────

test('metaSkillValue({ prompting:80, verification:60, decomposition:70, refactoring:90 }) → 75', () => {
  const axes = { prompting: 80, verification: 60, decomposition: 70, refactoring: 90 };
  assert.strictEqual(metaSkillValue(axes), 75);
});

test('metaSkillValue(null) → 0', () => {
  assert.strictEqual(metaSkillValue(null), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. getMetaSkillComponent — async, uses model stub
// ─────────────────────────────────────────────────────────────────────────────

test('getMetaSkillComponent: no mastery doc → { value:0, weight:0, contribution:0, attempt_count:0 }', async () => {
  reset();
  // stubFindOne is null → findOne returns null
  const result = await getMetaSkillComponent({ user_id: 'user1', role_track: 'swe' });
  assert.deepStrictEqual(result, { value: 0, weight: 0, contribution: 0, attempt_count: 0 });
});

test('getMetaSkillComponent: 3 attempts → weight=0, contribution=0 (below ramp)', async () => {
  reset();
  stubFindOne = {
    user_id: 'user1',
    role_track: 'swe',
    axes: { prompting: 80, verification: 80, decomposition: 80, refactoring: 80 },
    attempt_count: 3,
  };
  const result = await getMetaSkillComponent({ user_id: 'user1', role_track: 'swe' });
  assert.strictEqual(result.weight, 0);
  assert.strictEqual(result.contribution, 0);
  assert.strictEqual(result.attempt_count, 3);
});

test('getMetaSkillComponent: 10 attempts, all axes 60 → value=60, weight=0.10, contribution=6', async () => {
  reset();
  stubFindOne = {
    user_id: 'user1',
    role_track: 'swe',
    axes: { prompting: 60, verification: 60, decomposition: 60, refactoring: 60 },
    attempt_count: 10,
  };
  const result = await getMetaSkillComponent({ user_id: 'user1', role_track: 'swe' });
  assert.strictEqual(result.value, 60);
  assert.strictEqual(result.weight, 0.10);
  assert.strictEqual(result.contribution, 6);
  assert.strictEqual(result.attempt_count, 10);
});

test('getMetaSkillComponent: 7 attempts, all axes 80 → value=80, weight=0.04, contribution=3.2', async () => {
  reset();
  stubFindOne = {
    user_id: 'user1',
    role_track: 'swe',
    axes: { prompting: 80, verification: 80, decomposition: 80, refactoring: 80 },
    attempt_count: 7,
  };
  const result = await getMetaSkillComponent({ user_id: 'user1', role_track: 'swe' });
  assert.strictEqual(result.value, 80);
  // weight = 0.10 * (7-5)/(10-5) = 0.04 — use tolerance for floating-point arithmetic
  assert.ok(Math.abs(result.weight - 0.04) < 0.0001, `weight was ${result.weight}`);
  // 80 * ~0.04 = ~3.2
  assert.ok(Math.abs(result.contribution - 3.2) < 0.0001, `contribution was ${result.contribution}`);
  assert.strictEqual(result.attempt_count, 7);
});
