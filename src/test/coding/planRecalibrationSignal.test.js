'use strict';

/**
 * Unit tests for src/coding/services/planRecalibrationSignal.js
 *
 * All Mongoose model calls are stubbed — no DB connection required.
 * 12 cases covering: no attempts, insufficient attempts, trend directions,
 * metaSkill / difficulty lookups, and computeMix edge cases.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ── Stub state ────────────────────────────────────────────────────────────────

let stubAttempts    = [];    // array of DrillAttempt-like objects returned by find().sort().lean()
let stubCapstones   = [];    // array of CapstoneSession-like graded results
let stubMastery     = null;  // MetaSkillMastery.findOne result | null
let stubDiffState   = null;  // DifficultyState.findOne result   | null

// ── Coding models stub ────────────────────────────────────────────────────────

const models = require('../../coding/models');

// DrillAttempt.find() returns a sort().lean() chain
models.DrillAttempt.find = (_query) => ({
  sort: () => ({ lean: () => Promise.resolve(stubAttempts) }),
});

// CapstoneSession.find() returns a sort().lean() chain (coding engagement now
// spans drills + capstones).
models.CapstoneSession.find = (_query) => ({
  sort: () => ({ lean: () => Promise.resolve(stubCapstones) }),
});

// MetaSkillMastery.findOne() returns a lean() chain
models.MetaSkillMastery.findOne = (_query) => ({
  lean: () => Promise.resolve(stubMastery),
});

// DifficultyState.findOne() returns a lean() chain
models.DifficultyState.findOne = (_query) => ({
  lean: () => Promise.resolve(stubDiffState),
});

// ── Module under test — loaded AFTER stubs ────────────────────────────────────

const {
  getCodingEngagementSignal,
  computeMix,
} = require('../../coding/services/planRecalibrationSignal');

// ── Helpers ───────────────────────────────────────────────────────────────────

function reset() {
  stubAttempts  = [];
  stubCapstones = [];
  stubMastery   = null;
  stubDiffState = null;
}

const WEEK_START = new Date('2026-05-18T00:00:00.000Z');
const WEEK_END   = new Date('2026-05-25T23:59:59.999Z');

function makeAttempt(overallScore) {
  return {
    status: 'graded',
    submitted_at: new Date('2026-05-20T10:00:00.000Z'),
    grade: { overall_score: overallScore },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: No attempts in window
// ─────────────────────────────────────────────────────────────────────────────

test('no attempts in window → drillCount 0, meanScore null, trendDirection insufficient, drill mix 0', async () => {
  reset();
  stubAttempts = [];

  const signal = await getCodingEngagementSignal({
    userId: 'user1',
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
  });

  assert.strictEqual(signal.drillCount, 0);
  assert.strictEqual(signal.meanScore, null);
  assert.strictEqual(signal.trendDirection, 'insufficient');
  assert.strictEqual(signal.recommendedTaskMix.drill, 0);
  assert.strictEqual(signal.userId, 'user1');
  assert.deepStrictEqual(signal.window, { start: WEEK_START, end: WEEK_END });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: 2 attempts → trendDirection 'insufficient' (< 3)
// ─────────────────────────────────────────────────────────────────────────────

test('2 graded attempts → trendDirection insufficient', async () => {
  reset();
  stubAttempts = [makeAttempt(60), makeAttempt(80)];

  const signal = await getCodingEngagementSignal({
    userId: 'user1',
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
  });

  assert.strictEqual(signal.drillCount, 2);
  assert.strictEqual(signal.trendDirection, 'insufficient');
  // meanScore should be computed despite < 3 drills
  assert.ok(signal.meanScore !== null, 'meanScore should be set when scores exist');
  assert.strictEqual(signal.meanScore, 70);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: 3+ attempts trending up
// ─────────────────────────────────────────────────────────────────────────────

test('5 attempts [60,65,80,85,90] → trendDirection up', async () => {
  reset();
  stubAttempts = [60, 65, 80, 85, 90].map(makeAttempt);

  const signal = await getCodingEngagementSignal({
    userId: 'user1',
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
  });

  assert.strictEqual(signal.trendDirection, 'up');
  assert.strictEqual(signal.drillCount, 5);
  // mean of [60,65,80,85,90] = 76
  assert.strictEqual(signal.meanScore, 76);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: 3+ attempts trending down
// ─────────────────────────────────────────────────────────────────────────────

test('5 attempts [85,80,70,60,55] → trendDirection down', async () => {
  reset();
  stubAttempts = [85, 80, 70, 60, 55].map(makeAttempt);

  const signal = await getCodingEngagementSignal({
    userId: 'user1',
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
  });

  assert.strictEqual(signal.trendDirection, 'down');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: 3+ attempts flat
// ─────────────────────────────────────────────────────────────────────────────

test('5 attempts [70,72,71,73,70] → trendDirection flat', async () => {
  reset();
  stubAttempts = [70, 72, 71, 73, 70].map(makeAttempt);

  const signal = await getCodingEngagementSignal({
    userId: 'user1',
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
  });

  assert.strictEqual(signal.trendDirection, 'flat');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: role_track provided → metaSkillSnapshot populated from MetaSkillMastery
// ─────────────────────────────────────────────────────────────────────────────

test('role_track provided → metaSkillSnapshot and currentDifficulty populated', async () => {
  reset();
  stubAttempts  = [];
  stubMastery   = {
    user_id: 'user1',
    role_track: 'swe',
    axes: { prompting: 60, verification: 40, decomposition: 55, refactoring: 70 },
  };
  stubDiffState = { user_id: 'user1', role_track: 'swe', current_difficulty: 'medium' };

  const signal = await getCodingEngagementSignal({
    userId: 'user1',
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    role_track: 'swe',
  });

  assert.deepStrictEqual(signal.metaSkillSnapshot, {
    prompting: 60,
    verification: 40,
    decomposition: 55,
    refactoring: 70,
  });
  assert.strictEqual(signal.currentDifficulty, 'medium');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: role_track absent → metaSkillSnapshot null, currentDifficulty null
// ─────────────────────────────────────────────────────────────────────────────

test('role_track absent → metaSkillSnapshot null, currentDifficulty null', async () => {
  reset();
  stubAttempts = [makeAttempt(70)];

  const signal = await getCodingEngagementSignal({
    userId: 'user1',
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    // no role_track
  });

  assert.strictEqual(signal.metaSkillSnapshot, null);
  assert.strictEqual(signal.currentDifficulty, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: computeMix — no drills → default mix
// ─────────────────────────────────────────────────────────────────────────────

test('computeMix: drillCount=0 → { drill:0, content:0.6, quiz:0.4 }', () => {
  const mix = computeMix({ activityCount: 0, meanScore: null });
  assert.strictEqual(mix.drill, 0);
  assert.strictEqual(mix.content, 0.6);
  assert.strictEqual(mix.quiz, 0.4);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: computeMix — engaged user (5 drills, mean 70)
// ─────────────────────────────────────────────────────────────────────────────

test('computeMix: 5 drills, meanScore=70 → drill clamped to min(0.4, 5*0.06)=0.3', () => {
  const mix = computeMix({ activityCount: 5, meanScore: 70 });
  // drill = min(0.4, 5*0.06) = min(0.4, 0.3) = 0.3
  assert.strictEqual(mix.drill, 0.3);
  // remaining = 0.7; content = 0.7 * 0.6 = 0.42; quiz = 0.7 * 0.4 = 0.28
  assert.ok(Math.abs(mix.content - 0.42) < 0.0001, `content should be ~0.42, got ${mix.content}`);
  assert.ok(Math.abs(mix.quiz - 0.28) < 0.0001, `quiz should be ~0.28, got ${mix.quiz}`);
  // Weights should sum to 1
  assert.ok(Math.abs(mix.drill + mix.content + mix.quiz - 1) < 0.0001, 'weights must sum to 1');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: computeMix — struggling user (mean < 50)
// ─────────────────────────────────────────────────────────────────────────────

test('computeMix: 4 drills, meanScore=40 (< 50) → drill weight lowered', () => {
  const normalMix   = computeMix({ activityCount: 4, meanScore: 70 }); // no adjustment
  const strugglingMix = computeMix({ activityCount: 4, meanScore: 40 });  // mean < 50

  // Struggling user should have a lower drill weight
  assert.ok(
    strugglingMix.drill < normalMix.drill,
    `struggling drill weight ${strugglingMix.drill} should be < normal ${normalMix.drill}`
  );
  // Total should still sum to 1
  assert.ok(
    Math.abs(strugglingMix.drill + strugglingMix.content + strugglingMix.quiz - 1) < 0.0001,
    'struggling mix weights must sum to 1'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11: computeMix — mastering user (mean > 85)
// ─────────────────────────────────────────────────────────────────────────────

test('computeMix: 3 drills, meanScore=90 (> 85) → drill weight increased', () => {
  const normalMix    = computeMix({ activityCount: 3, meanScore: 70 }); // no adjustment
  const masteringMix = computeMix({ activityCount: 3, meanScore: 90 }); // mean > 85

  // Mastering user should have a higher drill weight
  assert.ok(
    masteringMix.drill > normalMix.drill,
    `mastering drill weight ${masteringMix.drill} should be > normal ${normalMix.drill}`
  );
  // Total should still sum to 1
  assert.ok(
    Math.abs(masteringMix.drill + masteringMix.content + masteringMix.quiz - 1) < 0.0001,
    'mastering mix weights must sum to 1'
  );
  // drill should be capped at 0.5
  assert.ok(masteringMix.drill <= 0.5, `drill weight must not exceed 0.5, got ${masteringMix.drill}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11b: capstones are merged into the engagement signal
// ─────────────────────────────────────────────────────────────────────────────

test('capstones merge into drillCount/capstoneCount + mean across both', async () => {
  reset();
  stubAttempts = [makeAttempt(60)]; // submitted 2026-05-20
  stubCapstones = [
    { status: 'graded', graded_at: new Date('2026-05-21T10:00:00.000Z'), result: { overall_score: 90 } },
  ];

  const signal = await getCodingEngagementSignal({
    userId: 'user1',
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
  });

  assert.strictEqual(signal.drillCount, 1);
  assert.strictEqual(signal.capstoneCount, 1);
  // mean of [60, 90] across drills + capstones = 75
  assert.strictEqual(signal.meanScore, 75);
  // engagement = 2 activities → drill mix = min(0.4, 2*0.06) = 0.12
  assert.ok(Math.abs(signal.recommendedTaskMix.drill - 0.12) < 0.0001);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 12: Error cases — missing required params
// ─────────────────────────────────────────────────────────────────────────────

test('getCodingEngagementSignal: missing userId → throws', async () => {
  reset();
  await assert.rejects(
    () => getCodingEngagementSignal({ weekStart: WEEK_START, weekEnd: WEEK_END }),
    /userId required/
  );
});

test('getCodingEngagementSignal: missing weekStart → throws', async () => {
  reset();
  await assert.rejects(
    () => getCodingEngagementSignal({ userId: 'user1', weekEnd: WEEK_END }),
    /weekStart and weekEnd required/
  );
});

test('getCodingEngagementSignal: missing weekEnd → throws', async () => {
  reset();
  await assert.rejects(
    () => getCodingEngagementSignal({ userId: 'user1', weekStart: WEEK_START }),
    /weekStart and weekEnd required/
  );
});
