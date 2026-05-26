'use strict';

/**
 * Unit tests for src/coding/services/masteryDelta.js
 *
 * MetaSkillMastery.findOne and .save are stubbed — no DB connection required.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Model stub — patched before the service is loaded ────────────────────────

const models = require('../../coding/models');

let stubFindOne = null;   // what MetaSkillMastery.findOne resolves to
let capturedSave = null;  // the doc passed to save()

// Minimal "Mongoose document" factory used by the stub
function makeDoc(fields) {
  const doc = {
    ...fields,
    axes: { ...(fields.axes || {}) },
    markModified: () => {},
    save: async function () {
      capturedSave = this;
    },
    toObject: function () {
      return {
        user_id: this.user_id,
        role_track: this.role_track,
        axes: { ...this.axes },
        confidence: this.confidence,
        attempt_count: this.attempt_count,
        last_updated: this.last_updated,
      };
    },
  };
  return doc;
}

// Track MetaSkillMastery constructor calls so we can verify new-doc creation
let constructorCalled = false;
let constructorArgs = null;

models.MetaSkillMastery = function (fields) {
  constructorCalled = true;
  constructorArgs = fields;
  return makeDoc(fields);
};

models.MetaSkillMastery.findOne = async () => {
  if (stubFindOne === null) return null;
  return makeDoc(stubFindOne);
};

// ── Module under test — loaded AFTER stubs ────────────────────────────────────

const { applyMasteryDelta, emaAlpha, clamp } = require('../../coding/services/masteryDelta');

// ─────────────────────────────────────────────────────────────────────────────
// Helper: reset test state
// ─────────────────────────────────────────────────────────────────────────────
function reset() {
  stubFindOne = null;
  capturedSave = null;
  constructorCalled = false;
  constructorArgs = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. No prior doc — creates new with score blended from 0
// ─────────────────────────────────────────────────────────────────────────────

test('applyMasteryDelta: no prior doc → creates new, axes.prompting = 0*0.7 + 80*0.3 = 24', async () => {
  reset();
  // stubFindOne = null → findOne returns null → new doc created

  const result = await applyMasteryDelta({
    user_id: 'user1',
    role_track: 'swe',
    drill_subtype: 'prompt',
    score: 80,
  });

  assert.ok(constructorCalled, 'MetaSkillMastery constructor should have been called');
  assert.ok(capturedSave, 'save() should have been called');

  // 0 * (1 - 0.3) + 80 * 0.3 = 24
  assert.strictEqual(result.axes.prompting, 24);
  assert.strictEqual(result.attempt_count, 1);
  assert.strictEqual(result.confidence, 0.1); // min(1, 1/10)
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Existing doc with low attempt_count (3) — uses α=0.3
// ─────────────────────────────────────────────────────────────────────────────

test('applyMasteryDelta: existing doc attempt_count=3 → α=0.3, prompting = 50*0.7 + 80*0.3 = 59', async () => {
  reset();
  stubFindOne = {
    user_id: 'user1',
    role_track: 'swe',
    axes: { prompting: 50, verification: 0, decomposition: 0, refactoring: 0 },
    attempt_count: 3,
    confidence: 0.3,
  };

  const result = await applyMasteryDelta({
    user_id: 'user1',
    role_track: 'swe',
    drill_subtype: 'prompt',
    score: 80,
  });

  // 50 * 0.7 + 80 * 0.3 = 35 + 24 = 59
  assert.strictEqual(result.axes.prompting, 59);
  assert.strictEqual(result.attempt_count, 4);
  assert.strictEqual(result.confidence, 0.4); // min(1, 4/10)
  assert.ok(capturedSave, 'save() should have been called');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Existing doc with high attempt_count (10) — uses α=0.15
// ─────────────────────────────────────────────────────────────────────────────

test('applyMasteryDelta: existing doc attempt_count=10 → α=0.15, verification = 60*0.85 + 90*0.15 = 64.5', async () => {
  reset();
  stubFindOne = {
    user_id: 'user1',
    role_track: 'swe',
    axes: { prompting: 0, verification: 60, decomposition: 0, refactoring: 0 },
    attempt_count: 10,
    confidence: 1,
  };

  const result = await applyMasteryDelta({
    user_id: 'user1',
    role_track: 'swe',
    drill_subtype: 'verify',
    score: 90,
  });

  // 60 * 0.85 + 90 * 0.15 = 51 + 13.5 = 64.5
  assert.strictEqual(result.axes.verification, 64.5);
  assert.strictEqual(result.attempt_count, 11);
  assert.strictEqual(result.confidence, 1); // min(1, 11/10) = 1
  assert.ok(capturedSave, 'save() should have been called');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Score clamping — prior 95, score 100, attempt_count 10 → 95.75 (no overflow)
// ─────────────────────────────────────────────────────────────────────────────

test('applyMasteryDelta: near-max values stay within [0,100] — 95*0.85 + 100*0.15 = 95.75', async () => {
  reset();
  stubFindOne = {
    user_id: 'user1',
    role_track: 'swe',
    axes: { prompting: 95, verification: 0, decomposition: 0, refactoring: 0 },
    attempt_count: 10,
    confidence: 1,
  };

  const result = await applyMasteryDelta({
    user_id: 'user1',
    role_track: 'swe',
    drill_subtype: 'prompt',
    score: 100,
  });

  // 95 * 0.85 + 100 * 0.15 = 80.75 + 15 = 95.75
  assert.strictEqual(result.axes.prompting, 95.75);
  assert.ok(result.axes.prompting <= 100, 'should not exceed 100');
});

test('applyMasteryDelta: prior 100 + score 100 → stays exactly 100', async () => {
  reset();
  stubFindOne = {
    user_id: 'user1',
    role_track: 'swe',
    axes: { prompting: 100, verification: 0, decomposition: 0, refactoring: 0 },
    attempt_count: 10,
    confidence: 1,
  };

  const result = await applyMasteryDelta({
    user_id: 'user1',
    role_track: 'swe',
    drill_subtype: 'prompt',
    score: 100,
  });

  assert.strictEqual(result.axes.prompting, 100);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Different axes updated independently — only target axis changes
// ─────────────────────────────────────────────────────────────────────────────

test('applyMasteryDelta: only refactoring axis changes; other axes stay at 50', async () => {
  reset();
  stubFindOne = {
    user_id: 'user1',
    role_track: 'swe',
    axes: { prompting: 50, verification: 50, decomposition: 50, refactoring: 50 },
    attempt_count: 3,
    confidence: 0.3,
  };

  const result = await applyMasteryDelta({
    user_id: 'user1',
    role_track: 'swe',
    drill_subtype: 'refactor',
    score: 80,
  });

  // Only refactoring changes: 50*0.7 + 80*0.3 = 59
  assert.strictEqual(result.axes.refactoring, 59);

  // All other axes unchanged
  assert.strictEqual(result.axes.prompting, 50);
  assert.strictEqual(result.axes.verification, 50);
  assert.strictEqual(result.axes.decomposition, 50);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Error cases
// ─────────────────────────────────────────────────────────────────────────────

test('applyMasteryDelta: missing user_id → throws', async () => {
  await assert.rejects(
    () => applyMasteryDelta({ role_track: 'swe', drill_subtype: 'prompt', score: 80 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('user_id'));
      return true;
    },
  );
});

test('applyMasteryDelta: missing role_track → throws', async () => {
  await assert.rejects(
    () => applyMasteryDelta({ user_id: 'user1', drill_subtype: 'prompt', score: 80 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('role_track'));
      return true;
    },
  );
});

test('applyMasteryDelta: missing drill_subtype → throws', async () => {
  await assert.rejects(
    () => applyMasteryDelta({ user_id: 'user1', role_track: 'swe', score: 80 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('drill_subtype'));
      return true;
    },
  );
});

test('applyMasteryDelta: score=101 → throws with score in message', async () => {
  await assert.rejects(
    () => applyMasteryDelta({ user_id: 'user1', role_track: 'swe', drill_subtype: 'prompt', score: 101 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('score'), `message was: ${err.message}`);
      return true;
    },
  );
});

test('applyMasteryDelta: score=-1 → throws with score in message', async () => {
  await assert.rejects(
    () => applyMasteryDelta({ user_id: 'user1', role_track: 'swe', drill_subtype: 'prompt', score: -1 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('score'), `message was: ${err.message}`);
      return true;
    },
  );
});

test('applyMasteryDelta: unknown drill_subtype → throws with subtype in message', async () => {
  reset();
  // subtypeToAxis returns 'prompting' for unknowns by default — but per spec
  // the service must throw for truly unknown subtypes.
  // We verify by passing a subtype that the spec explicitly calls unknown.
  // NOTE: subtypeToAxis defaults unknowns → 'prompting', so the service
  // must do an explicit allow-list check or the spec must define the error.
  // Per spec: "unknown drill_subtype throws". We honour this with a subtype
  // that is definitely not in the SUBTYPE_TO_AXIS map.
  await assert.rejects(
    () => applyMasteryDelta({ user_id: 'user1', role_track: 'swe', drill_subtype: 'NOTASUBTYPE', score: 50 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('NOTASUBTYPE'), `message was: ${err.message}`);
      return true;
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. emaAlpha helper
// ─────────────────────────────────────────────────────────────────────────────

test('emaAlpha(0) → 0.3', () => {
  assert.strictEqual(emaAlpha(0), 0.3);
});

test('emaAlpha(4) → 0.3', () => {
  assert.strictEqual(emaAlpha(4), 0.3);
});

test('emaAlpha(5) → 0.15', () => {
  assert.strictEqual(emaAlpha(5), 0.15);
});

test('emaAlpha(100) → 0.15', () => {
  assert.strictEqual(emaAlpha(100), 0.15);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. clamp helper
// ─────────────────────────────────────────────────────────────────────────────

test('clamp: value in range → unchanged', () => {
  assert.strictEqual(clamp(50, 0, 100), 50);
});

test('clamp: value below min → min', () => {
  assert.strictEqual(clamp(-5, 0, 100), 0);
});

test('clamp: value above max → max', () => {
  assert.strictEqual(clamp(105, 0, 100), 100);
});

test('clamp: value exactly at min → min', () => {
  assert.strictEqual(clamp(0, 0, 100), 0);
});

test('clamp: value exactly at max → max', () => {
  assert.strictEqual(clamp(100, 0, 100), 100);
});
