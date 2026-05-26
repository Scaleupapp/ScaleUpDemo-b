'use strict';

/**
 * Unit tests for scripts/rollback-coding-backfill.js
 *
 * All Mongoose models are stubbed in-process — no DB or network required.
 *
 * Strategy:
 *   Stub coding models (MetaSkillMastery, DifficultyState) via the coding models
 *   index cache, and Notification via require.cache, before loading the script.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('path');

// ── Stub coding models before the script loads them ──────────────────────────

const codingModels = require('../../coding/models');

// Per-test control variables
let stubMasteryFindDocs      = [];  // MetaSkillMastery.find result
let capturedMasteryDeletes   = [];  // ids passed to MetaSkillMastery.deleteOne
let stubDiffFindDocs         = [];  // DifficultyState.find result
let capturedDiffDeletes      = [];  // ids passed to DifficultyState.deleteOne

// Default stub — override per test for error cases
let masteryDeleteImpl = async ({ _id }) => { capturedMasteryDeletes.push(_id); };
let diffDeleteImpl    = async ({ _id }) => { capturedDiffDeletes.push(_id); };

codingModels.MetaSkillMastery = {
  find: (_filter) => ({
    lean: async () => stubMasteryFindDocs,
  }),
  deleteOne: async (q) => masteryDeleteImpl(q),
};

codingModels.DifficultyState = {
  find: (_filter) => ({
    lean: async () => stubDiffFindDocs,
  }),
  deleteOne: async (q) => diffDeleteImpl(q),
};

// ── Stub Notification model via require.cache ─────────────────────────────────

let stubNotifFindDocs    = [];  // Notification.find result
let capturedNotifUpdates = [];  // { _id, update } for each Notification.updateOne call

function makeCacheStub(resolvedPath, mod) {
  require.cache[require.resolve(resolvedPath)] = {
    id: require.resolve(resolvedPath),
    filename: require.resolve(resolvedPath),
    loaded: true,
    exports: mod,
  };
}

const ROOT = path.resolve(__dirname, '../../..');
const notificationPath = path.resolve(ROOT, 'src/models/Notification');

const NotificationStub = {
  find: (_filter) => ({
    lean: async () => stubNotifFindDocs,
  }),
  updateOne: async (query, update) => {
    capturedNotifUpdates.push({ _id: query._id, update });
  },
};

makeCacheStub(notificationPath, NotificationStub);

// ── Load the module under test AFTER stubs are in place ──────────────────────

const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/rollback-coding-backfill.js');
const {
  runRollback,
  isUntouchedMastery,
  isUntouchedDifficulty,
  findMasteryToDelete,
  findDifficultyToDelete,
  findNotificationsToMark,
  BACKFILL_BATCH_TAG,
} = require(SCRIPT_PATH);

// ── Helpers ───────────────────────────────────────────────────────────────────

const silentLogger = { log: () => {} };

function makeMastery(overrides = {}) {
  return {
    _id: 'mastery1',
    user_id: 'user1',
    role_track: 'swe',
    attempt_count: 0,
    axes: { prompting: 0, verification: 0, decomposition: 0, refactoring: 0 },
    ...overrides,
  };
}

function makeDifficulty(overrides = {}) {
  return {
    _id: 'diff1',
    user_id: 'user1',
    role_track: 'swe',
    current_difficulty: 'easy',
    recommendation_history: [],
    ...overrides,
  };
}

function makeNotification(overrides = {}) {
  return {
    _id: 'notif1',
    data: { backfill_batch: BACKFILL_BATCH_TAG },
    status: 'pending',
    ...overrides,
  };
}

function reset() {
  stubMasteryFindDocs    = [];
  capturedMasteryDeletes = [];
  stubDiffFindDocs       = [];
  capturedDiffDeletes    = [];
  stubNotifFindDocs      = [];
  capturedNotifUpdates   = [];

  // Restore default impls
  masteryDeleteImpl = async ({ _id }) => { capturedMasteryDeletes.push(_id); };
  diffDeleteImpl    = async ({ _id }) => { capturedDiffDeletes.push(_id); };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. isUntouchedMastery — all axes 0, attempt_count 0 → true
// ─────────────────────────────────────────────────────────────────────────────

test('isUntouchedMastery: all axes 0, attempt_count 0 → true', () => {
  const doc = makeMastery();
  assert.strictEqual(isUntouchedMastery(doc), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. isUntouchedMastery — one axis at 50 → false
// ─────────────────────────────────────────────────────────────────────────────

test('isUntouchedMastery: prompting axis at 50 → false', () => {
  const doc = makeMastery({ axes: { prompting: 50, verification: 0, decomposition: 0, refactoring: 0 } });
  assert.strictEqual(isUntouchedMastery(doc), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. isUntouchedMastery — attempt_count 1 → false
// ─────────────────────────────────────────────────────────────────────────────

test('isUntouchedMastery: attempt_count 1 → false (user has activity)', () => {
  const doc = makeMastery({ attempt_count: 1 });
  assert.strictEqual(isUntouchedMastery(doc), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. isUntouchedDifficulty — 'easy' + no history → true
// ─────────────────────────────────────────────────────────────────────────────

test('isUntouchedDifficulty: easy + empty recommendation_history → true', () => {
  const doc = makeDifficulty();
  assert.strictEqual(isUntouchedDifficulty(doc), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. isUntouchedDifficulty — 'easy' + 1 recommendation → false
// ─────────────────────────────────────────────────────────────────────────────

test('isUntouchedDifficulty: easy + 1 recommendation in history → false', () => {
  const doc = makeDifficulty({ recommendation_history: [{ recommended: 'medium', reason: 'r', accepted: true }] });
  assert.strictEqual(isUntouchedDifficulty(doc), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. isUntouchedDifficulty — 'medium' → false
// ─────────────────────────────────────────────────────────────────────────────

test('isUntouchedDifficulty: current_difficulty medium → false', () => {
  const doc = makeDifficulty({ current_difficulty: 'medium' });
  assert.strictEqual(isUntouchedDifficulty(doc), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. runRollback happy path — deletes 2 mastery + 1 difficulty + marks 2 notifications
// ─────────────────────────────────────────────────────────────────────────────

test('runRollback: happy path — correct delete + mark counts', async () => {
  reset();
  stubMasteryFindDocs = [makeMastery({ _id: 'm1' }), makeMastery({ _id: 'm2' })];
  stubDiffFindDocs    = [makeDifficulty({ _id: 'd1' })];
  stubNotifFindDocs   = [makeNotification({ _id: 'n1' }), makeNotification({ _id: 'n2' })];

  const summary = await runRollback({ logger: silentLogger });

  assert.strictEqual(summary.mastery_to_delete,      2);
  assert.strictEqual(summary.mastery_deleted,         2);
  assert.strictEqual(summary.difficulty_to_delete,   1);
  assert.strictEqual(summary.difficulty_deleted,      1);
  assert.strictEqual(summary.notifications_to_mark,  2);
  assert.strictEqual(summary.notifications_marked,   2);
  assert.deepStrictEqual(summary.errors, []);

  assert.strictEqual(capturedMasteryDeletes.length, 2);
  assert.strictEqual(capturedDiffDeletes.length,    1);
  assert.strictEqual(capturedNotifUpdates.length,   2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. runRollback dry-run — no DB writes; _to_delete counts are set; _deleted/_marked are 0
// ─────────────────────────────────────────────────────────────────────────────

test('runRollback: dry-run — no writes, to_delete populated, deleted/marked are 0', async () => {
  reset();
  stubMasteryFindDocs = [makeMastery({ _id: 'm1' }), makeMastery({ _id: 'm2' })];
  stubDiffFindDocs    = [makeDifficulty({ _id: 'd1' })];
  stubNotifFindDocs   = [makeNotification({ _id: 'n1' })];

  const summary = await runRollback({ dryRun: true, logger: silentLogger });

  // to_delete / to_mark should reflect what would have been done
  assert.strictEqual(summary.mastery_to_delete,     2);
  assert.strictEqual(summary.difficulty_to_delete,  1);
  assert.strictEqual(summary.notifications_to_mark, 1);

  // No actual DB writes
  assert.strictEqual(summary.mastery_deleted,       0);
  assert.strictEqual(summary.difficulty_deleted,    0);
  assert.strictEqual(summary.notifications_marked,  0);

  assert.strictEqual(capturedMasteryDeletes.length, 0);
  assert.strictEqual(capturedDiffDeletes.length,    0);
  assert.strictEqual(capturedNotifUpdates.length,   0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. runRollback error path — one delete throws → captured in errors, doesn't abort
// ─────────────────────────────────────────────────────────────────────────────

test('runRollback: one mastery delete throws → error captured, rest continues', async () => {
  reset();
  stubMasteryFindDocs = [makeMastery({ _id: 'good' }), makeMastery({ _id: 'bad' })];
  stubDiffFindDocs    = [makeDifficulty({ _id: 'd1' })];
  stubNotifFindDocs   = [];

  // Make deleteOne throw for 'bad'
  masteryDeleteImpl = async ({ _id }) => {
    if (_id === 'bad') throw new Error('simulated delete error');
    capturedMasteryDeletes.push(_id);
  };

  const summary = await runRollback({ logger: silentLogger });

  assert.strictEqual(summary.errors.length, 1, 'one error logged');
  assert.ok(summary.errors[0].error.includes('simulated delete error'), 'error message preserved');
  assert.strictEqual(summary.errors[0].collection, 'MetaSkillMastery');

  // Good mastery was still deleted, difficulty was still deleted
  assert.strictEqual(summary.mastery_deleted,    1);
  assert.strictEqual(summary.difficulty_deleted, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. findNotificationsToMark queries with correct backfill_batch tag
// ─────────────────────────────────────────────────────────────────────────────

test('findNotificationsToMark: queries with data.backfill_batch === BACKFILL_BATCH_TAG', async () => {
  reset();

  // Capture the filter passed to Notification.find
  let capturedFilter = null;
  NotificationStub.find = (filter) => {
    capturedFilter = filter;
    return { lean: async () => [] };
  };

  await findNotificationsToMark();

  assert.ok(capturedFilter !== null, 'Notification.find was called');
  assert.strictEqual(
    capturedFilter['data.backfill_batch'],
    BACKFILL_BATCH_TAG,
    `expected filter key 'data.backfill_batch' === '${BACKFILL_BATCH_TAG}'`
  );

  // Restore
  NotificationStub.find = (_filter) => ({ lean: async () => stubNotifFindDocs });
});
