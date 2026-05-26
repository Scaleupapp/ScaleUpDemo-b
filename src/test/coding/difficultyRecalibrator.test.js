'use strict';

/**
 * Unit tests for src/coding/services/difficultyRecalibrator.js
 *
 * DifficultyState, DrillAttempt, and ArtifactBundle are stubbed —
 * no DB connection required.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ── Model stubs patched before the service is loaded ─────────────────────────

const models = require('../../coding/models');

// ---- DrillAttempt stub ----
let stubAttempt = null;   // object returned by findById().lean()
models.DrillAttempt = {
  findById: () => ({ lean: async () => stubAttempt }),
};

// ---- ArtifactBundle stub ----
let stubBundle = null;    // object returned by findById().lean()
models.ArtifactBundle = {
  findById: () => ({ lean: async () => stubBundle }),
};

// ---- DifficultyState stub ----
let stubState   = null;   // object (or null) returned by findOne
let savedState  = null;   // captured after save()
let ctorCalled  = false;
let ctorArgs    = null;

function makeStateDoc(fields) {
  const doc = {
    ...fields,
    recommendation_history: [...(fields.recommendation_history || [])],
    save: async function () { savedState = this; },
  };
  return doc;
}

models.DifficultyState = function (fields) {
  ctorCalled = true;
  ctorArgs   = fields;
  return makeStateDoc(fields);
};
models.DifficultyState.findOne = async () => {
  if (stubState === null) return null;
  return makeStateDoc(stubState);
};

// ── Service loaded AFTER stubs ────────────────────────────────────────────────

const {
  stepUp,
  stepDown,
  computeDirection,
  recommendNext,
  recordRecommendation,
  applyRecommendation,
} = require('../../coding/services/difficultyRecalibrator');

// ── Helper ────────────────────────────────────────────────────────────────────

function reset() {
  stubAttempt  = null;
  stubBundle   = null;
  stubState    = null;
  savedState   = null;
  ctorCalled   = false;
  ctorArgs     = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. stepUp — ladder edges and middle
// ─────────────────────────────────────────────────────────────────────────────

test('stepUp(easy) → medium', () => {
  assert.strictEqual(stepUp('easy'), 'medium');
});

test('stepUp(medium) → hard', () => {
  assert.strictEqual(stepUp('medium'), 'hard');
});

test('stepUp(hard) → hard (already at top)', () => {
  assert.strictEqual(stepUp('hard'), 'hard');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. stepDown — ladder edges and middle
// ─────────────────────────────────────────────────────────────────────────────

test('stepDown(hard) → medium', () => {
  assert.strictEqual(stepDown('hard'), 'medium');
});

test('stepDown(medium) → easy', () => {
  assert.strictEqual(stepDown('medium'), 'easy');
});

test('stepDown(easy) → easy (already at bottom)', () => {
  assert.strictEqual(stepDown('easy'), 'easy');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. computeDirection — two up-signals
// ─────────────────────────────────────────────────────────────────────────────

test('computeDirection score>85 + time<60% → direction +2, both signals present', () => {
  const { direction, signals } = computeDirection({ score: 90, time_ratio: 0.5 });
  assert.strictEqual(direction, 2);
  assert.ok(signals.includes('score>85'),  `signals: ${signals}`);
  assert.ok(signals.includes('time<60%'),  `signals: ${signals}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. computeDirection — two down-signals
// ─────────────────────────────────────────────────────────────────────────────

test('computeDirection score<50 + time>105% → direction -2', () => {
  const { direction, signals } = computeDirection({ score: 40, time_ratio: 1.2 });
  assert.strictEqual(direction, -2);
  assert.ok(signals.includes('score<50'),   `signals: ${signals}`);
  assert.ok(signals.includes('time>105%'),  `signals: ${signals}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. computeDirection — neutral (both signals in middle-range)
// ─────────────────────────────────────────────────────────────────────────────

test('computeDirection score=70 + time_ratio=0.8 → direction 0, signals empty', () => {
  const { direction, signals } = computeDirection({ score: 70, time_ratio: 0.8 });
  assert.strictEqual(direction, 0);
  assert.strictEqual(signals.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. recommendNext — easy + both up → medium
// ─────────────────────────────────────────────────────────────────────────────

test('recommendNext: easy + score 90 + time 0.5 → medium', () => {
  const { recommended } = recommendNext({ current_difficulty: 'easy', score: 90, time_ratio: 0.5 });
  assert.strictEqual(recommended, 'medium');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. recommendNext — hard + both up → stays hard (already at top)
// ─────────────────────────────────────────────────────────────────────────────

test('recommendNext: hard + score 90 + time 0.5 → hard (ladder cap)', () => {
  const { recommended } = recommendNext({ current_difficulty: 'hard', score: 90, time_ratio: 0.5 });
  assert.strictEqual(recommended, 'hard');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. recommendNext — medium + both down → easy
// ─────────────────────────────────────────────────────────────────────────────

test('recommendNext: medium + score 40 + time 1.5 → easy', () => {
  const { recommended } = recommendNext({ current_difficulty: 'medium', score: 40, time_ratio: 1.5 });
  assert.strictEqual(recommended, 'easy');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. recommendNext — neutral stay
// ─────────────────────────────────────────────────────────────────────────────

test('recommendNext: easy + score 70 + time 0.9 → easy (stay)', () => {
  const { recommended } = recommendNext({ current_difficulty: 'easy', score: 70, time_ratio: 0.9 });
  assert.strictEqual(recommended, 'easy');
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. recommendNext — mixed signals cancel out → stay
// ─────────────────────────────────────────────────────────────────────────────

test('recommendNext: score>85 (up) + time>105% (down) → direction 0 → stay', () => {
  // score 90 → +1; time_ratio 1.1 → -1; direction = 0 → stay
  const { recommended, direction } = recommendNext({
    current_difficulty: 'medium',
    score: 90,
    time_ratio: 1.1,
  });
  assert.strictEqual(direction, 0);
  assert.strictEqual(recommended, 'medium');
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. recordRecommendation — happy path: existing DifficultyState 'easy',
//     graded attempt score 90 + time_ratio 0.5 → recommendation 'medium'
// ─────────────────────────────────────────────────────────────────────────────

test('recordRecommendation: existing state easy + score 90 + time 0.5 → pushes medium recommendation', async () => {
  reset();

  stubAttempt = {
    _id: 'attempt1',
    bundle_id: 'bundle1',
    time_taken_seconds: 900,      // 900 s
    grade: { overall_score: 90 },
  };
  stubBundle = {
    _id: 'bundle1',
    time_budget_minutes: 30,      // 1800 s budget → time_ratio = 900/1800 = 0.5
  };
  stubState = {
    user_id: 'user1',
    role_track: 'swe',
    current_difficulty: 'easy',
    recommendation_history: [],
  };

  const result = await recordRecommendation({
    user_id: 'user1',
    role_track: 'swe',
    drillAttemptId: 'attempt1',
  });

  assert.strictEqual(result.recommended, 'medium');
  assert.strictEqual(result.current, 'easy');    // current_difficulty not changed yet
  assert.ok(savedState, 'save() should have been called');
  assert.strictEqual(savedState.recommendation_history.length, 1);
  assert.strictEqual(savedState.recommendation_history[0].recommended, 'medium');
  assert.strictEqual(savedState.recommendation_history[0].accepted, null);
  assert.ok(savedState.recommendation_history[0].timestamp instanceof Date);
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. recordRecommendation — no DifficultyState yet → creates default 'easy'
// ─────────────────────────────────────────────────────────────────────────────

test('recordRecommendation: no existing state → creates default easy, pushes recommendation', async () => {
  reset();

  stubAttempt = {
    _id: 'attempt2',
    bundle_id: 'bundle2',
    time_taken_seconds: 600,
    grade: { overall_score: 40 },  // score<50 → down, but easy → stays easy
  };
  stubBundle = {
    _id: 'bundle2',
    time_budget_minutes: 20,        // 1200 s budget → time_ratio = 600/1200 = 0.5 → up
    // direction = -1 (score<50) +1 (time<60%) = 0 → stay
  };
  // stubState = null → no existing state → constructor called

  const result = await recordRecommendation({
    user_id: 'user2',
    role_track: 'ds',
    drillAttemptId: 'attempt2',
  });

  assert.ok(ctorCalled, 'DifficultyState constructor should have been called');
  assert.strictEqual(ctorArgs.current_difficulty, 'easy');
  assert.strictEqual(result.current, 'easy');
  assert.ok(savedState, 'save() should have been called');
  assert.strictEqual(savedState.recommendation_history.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. recordRecommendation — no grade yet → throws
// ─────────────────────────────────────────────────────────────────────────────

test('recordRecommendation: attempt has no grade → throws', async () => {
  reset();

  stubAttempt = {
    _id: 'attempt3',
    bundle_id: 'bundle3',
    time_taken_seconds: 100,
    grade: null,   // no grade
  };
  stubBundle = { _id: 'bundle3', time_budget_minutes: 20 };
  stubState  = null;

  await assert.rejects(
    () => recordRecommendation({ user_id: 'user1', role_track: 'swe', drillAttemptId: 'attempt3' }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.toLowerCase().includes('grade'), `message: ${err.message}`);
      return true;
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. applyRecommendation — accepted=true updates current_difficulty
//     accepted=false keeps current_difficulty unchanged
// ─────────────────────────────────────────────────────────────────────────────

test('applyRecommendation: accepted=true → current_difficulty updated to recommendation', async () => {
  reset();

  stubState = {
    user_id: 'user1',
    role_track: 'swe',
    current_difficulty: 'easy',
    recommendation_history: [
      { recommended: 'medium', reason: 'up: score>85+time<60%', accepted: null, timestamp: new Date() },
    ],
  };

  const result = await applyRecommendation({ user_id: 'user1', role_track: 'swe', accepted: true });

  assert.strictEqual(result.current_difficulty, 'medium');
  assert.strictEqual(result.applied, true);
  assert.ok(savedState, 'save() should have been called');
  assert.strictEqual(savedState.recommendation_history[0].accepted, true);
});

test('applyRecommendation: accepted=false → current_difficulty unchanged', async () => {
  reset();

  stubState = {
    user_id: 'user1',
    role_track: 'swe',
    current_difficulty: 'easy',
    recommendation_history: [
      { recommended: 'medium', reason: 'up: score>85', accepted: null, timestamp: new Date() },
    ],
  };

  const result = await applyRecommendation({ user_id: 'user1', role_track: 'swe', accepted: false });

  assert.strictEqual(result.current_difficulty, 'easy');
  assert.strictEqual(result.applied, false);
  assert.ok(savedState, 'save() should have been called');
  assert.strictEqual(savedState.recommendation_history[0].accepted, false);
});
