'use strict';

/**
 * Unit tests for scripts/backfill-coding-meta-skills.js
 *
 * All Mongoose models are stubbed in-process — no DB or network required.
 *
 * Strategy:
 *   1. Require the coding models index and stub MetaSkillMastery first.
 *   2. Inject User, UserObjective, Notification stubs directly on the
 *      module under test's exported helpers via the module's own require
 *      cache slots (we inject before the script loads models at require-time).
 *   3. Import the backfill helpers AFTER stubs are in place.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('path');

// ── Stub coding models before the script loads them ──────────────────────────

const codingModels = require('../../coding/models');

let stubMasteryFindOne  = null;   // MetaSkillMastery.findOne result
let capturedMasteryCreate = [];   // MetaSkillMastery.create calls

codingModels.MetaSkillMastery = {
  findOne: async () => stubMasteryFindOne,
  create:  async (doc) => { capturedMasteryCreate.push(doc); return doc; },
};

// ── Stubs for User / UserObjective / Notification ────────────────────────────
// These are injected into require.cache so the script's try/catch require()
// picks them up from Node's module cache instead of loading the real files.

let stubObjectives       = [];   // array of objective docs returned by UserObjective.find
let stubUserMap          = {};   // userId (string) → user doc (or null)
let stubNotificationFindOne = null;  // Notification.findOne result
let capturedNotificationCreate = [];

function makeCacheStub(resolvedPath, mod) {
  require.cache[require.resolve(resolvedPath)] = {
    id: require.resolve(resolvedPath),
    filename: require.resolve(resolvedPath),
    loaded: true,
    exports: mod,
  };
}

const ROOT = path.resolve(__dirname, '../../..');

const userPath         = path.resolve(ROOT, 'src/models/User');
const userObjectivePath = path.resolve(ROOT, 'src/models/UserObjective');
const notificationPath  = path.resolve(ROOT, 'src/models/Notification');

const UserStub = {
  findById: (id) => ({
    select: () => ({
      lean: async () => stubUserMap[id.toString()] || null,
    }),
  }),
};

const UserObjectiveStub = {
  find: (_filter) => ({
    limit: (_n) => ({
      lean: async () => stubObjectives,
    }),
  }),
};

const NotificationStub = {
  findOne: async () => stubNotificationFindOne,
  create:  async (doc) => { capturedNotificationCreate.push(doc); return doc; },
};

makeCacheStub(userPath,         UserStub);
makeCacheStub(userObjectivePath, UserObjectiveStub);
makeCacheStub(notificationPath,  NotificationStub);

// ── Load the module under test AFTER all stubs are in place ──────────────────

const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/backfill-coding-meta-skills.js');
const { runBackfill, backfillUser, findEligibleUsers, BACKFILL_BATCH_TAG } = require(SCRIPT_PATH);

// ── Helpers ───────────────────────────────────────────────────────────────────

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const recentDate    = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
const oldDate       = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days ago (> 60 day window)

function makeObjective(overrides = {}) {
  return {
    userId: 'user1',
    status: 'active',
    isPrimary: true,
    canonicalTopic: 'software-engineer',
    ...overrides,
  };
}

function makeUser(overrides = {}) {
  return {
    lastLoginAt: recentDate,
    notificationPreferences: {},
    ...overrides,
  };
}

const silentLogger = { log: () => {} };

function reset() {
  stubMasteryFindOne         = null;
  capturedMasteryCreate      = [];
  stubObjectives             = [];
  stubUserMap                = {};
  stubNotificationFindOne    = null;
  capturedNotificationCreate = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. No eligible users
// ─────────────────────────────────────────────────────────────────────────────

test('runBackfill: no eligible users → eligible:0, backfilled:0', async () => {
  reset();
  stubObjectives = []; // no objectives

  const summary = await runBackfill({ logger: silentLogger });

  assert.strictEqual(summary.eligible,  0);
  assert.strictEqual(summary.backfilled, 0);
  assert.strictEqual(summary.skipped,   0);
  assert.strictEqual(summary.pushed,    0);
  assert.deepStrictEqual(summary.errors, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Eligible user with no existing mastery → create mastery + push
// ─────────────────────────────────────────────────────────────────────────────

test('runBackfill: eligible user, no existing mastery → MetaSkillMastery.create and Notification.create called', async () => {
  reset();
  stubObjectives  = [makeObjective({ userId: 'user1' })];
  stubUserMap['user1'] = makeUser();
  stubMasteryFindOne   = null;   // no existing mastery
  stubNotificationFindOne = null; // no existing push

  const summary = await runBackfill({ logger: silentLogger });

  assert.strictEqual(summary.eligible,  1);
  assert.strictEqual(summary.backfilled, 1);
  assert.strictEqual(summary.pushed,    1);
  assert.strictEqual(summary.skipped,   0);

  // MetaSkillMastery.create was called with zeroed axes
  assert.strictEqual(capturedMasteryCreate.length, 1);
  const mDoc = capturedMasteryCreate[0];
  assert.strictEqual(mDoc.role_track, 'swe');
  assert.strictEqual(mDoc.axes.prompting,     0);
  assert.strictEqual(mDoc.axes.verification,  0);
  assert.strictEqual(mDoc.axes.decomposition, 0);
  assert.strictEqual(mDoc.axes.refactoring,   0);
  assert.strictEqual(mDoc.confidence,         0);
  assert.strictEqual(mDoc.attempt_count,      0);

  // Notification.create was called
  assert.strictEqual(capturedNotificationCreate.length, 1);
  const nDoc = capturedNotificationCreate[0];
  assert.strictEqual(nDoc.type,   'coding_calibration_invitation');
  assert.strictEqual(nDoc.status, 'pending');
  assert.ok(nDoc.title,  'notification should have a title');
  assert.ok(nDoc.message, 'notification should have a message');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Idempotent re-run: mastery already exists → action 'skipped'
// ─────────────────────────────────────────────────────────────────────────────

test('runBackfill: mastery already exists → action skipped, no new create', async () => {
  reset();
  stubObjectives  = [makeObjective({ userId: 'user2' })];
  stubUserMap['user2'] = makeUser();
  stubMasteryFindOne   = { user_id: 'user2', role_track: 'swe' }; // existing mastery

  const summary = await runBackfill({ logger: silentLogger });

  assert.strictEqual(summary.eligible,  1);
  assert.strictEqual(summary.skipped,   1);
  assert.strictEqual(summary.backfilled, 0);
  assert.strictEqual(summary.pushed,    0);
  assert.strictEqual(capturedMasteryCreate.length,      0);
  assert.strictEqual(capturedNotificationCreate.length,  0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Idempotent push: mastery does not exist, but push already sent → pushed:false
// ─────────────────────────────────────────────────────────────────────────────

test('runBackfill: mastery absent but notification already exists → backfilled:1, pushed:false', async () => {
  reset();
  stubObjectives  = [makeObjective({ userId: 'user3' })];
  stubUserMap['user3'] = makeUser();
  stubMasteryFindOne     = null;  // no mastery
  stubNotificationFindOne = { userId: 'user3', type: 'coding_calibration_invitation' }; // already pushed

  const summary = await runBackfill({ logger: silentLogger });

  assert.strictEqual(summary.backfilled, 1);
  assert.strictEqual(summary.pushed,    0);  // no new push
  assert.strictEqual(capturedMasteryCreate.length,     1);   // mastery was still created
  assert.strictEqual(capturedNotificationCreate.length, 0);  // no new notification
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Dry-run: no DB writes, all actions 'dry_run'
// ─────────────────────────────────────────────────────────────────────────────

test('runBackfill: dry-run=true → no DB writes, dry_run returned', async () => {
  reset();
  stubObjectives  = [makeObjective({ userId: 'user4' })];
  stubUserMap['user4'] = makeUser();
  stubMasteryFindOne   = null;

  const summary = await runBackfill({ dryRun: true, logger: silentLogger });

  // No DB writes
  assert.strictEqual(capturedMasteryCreate.length,      0);
  assert.strictEqual(capturedNotificationCreate.length,  0);

  // Summary shows dry-run traffic
  assert.strictEqual(summary.eligible,  1);
  assert.strictEqual(summary.backfilled, 0); // not counted as backfilled
  assert.strictEqual(summary.pushed,    0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Inactive user (lastLoginAt older than 60 days) → excluded
// ─────────────────────────────────────────────────────────────────────────────

test('findEligibleUsers: user inactive for 90 days → excluded', async () => {
  reset();
  stubObjectives  = [makeObjective({ userId: 'user5' })];
  stubUserMap['user5'] = makeUser({ lastLoginAt: oldDate });

  const sinceDate = new Date(Date.now() - SIXTY_DAYS_MS);
  const candidates = await findEligibleUsers({ since: sinceDate, limit: 100 });

  assert.strictEqual(candidates.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Non-coding objective → excluded
// ─────────────────────────────────────────────────────────────────────────────

test('findEligibleUsers: non-coding objective (canonicalTopic=placement) → excluded', async () => {
  reset();
  stubObjectives  = [makeObjective({ userId: 'user6', canonicalTopic: 'placement' })];
  stubUserMap['user6'] = makeUser();

  const sinceDate = new Date(Date.now() - SIXTY_DAYS_MS);
  const candidates = await findEligibleUsers({ since: sinceDate, limit: 100 });

  assert.strictEqual(candidates.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. User with notificationPreferences.productUpdates === false → excluded
// ─────────────────────────────────────────────────────────────────────────────

test('findEligibleUsers: productUpdates opted out → excluded', async () => {
  reset();
  stubObjectives  = [makeObjective({ userId: 'user7' })];
  stubUserMap['user7'] = makeUser({ notificationPreferences: { productUpdates: false } });

  const sinceDate = new Date(Date.now() - SIXTY_DAYS_MS);
  const candidates = await findEligibleUsers({ since: sinceDate, limit: 100 });

  assert.strictEqual(candidates.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Batch size respected: batchSize=2 with 5 eligible → at most 2 candidates
// ─────────────────────────────────────────────────────────────────────────────

test('findEligibleUsers: batchSize=2 limits candidates to 2', async () => {
  reset();
  const ids = ['u1', 'u2', 'u3', 'u4', 'u5'];
  stubObjectives = ids.map(id => makeObjective({ userId: id }));
  for (const id of ids) {
    stubUserMap[id] = makeUser();
  }

  const sinceDate = new Date(Date.now() - SIXTY_DAYS_MS);
  const candidates = await findEligibleUsers({ since: sinceDate, limit: 2 });

  assert.ok(candidates.length <= 2, `expected <= 2 candidates, got ${candidates.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Error in one user → logged in summary.errors, rest of batch continues
// ─────────────────────────────────────────────────────────────────────────────

test('runBackfill: error on one user → logged in errors, does not abort batch', async () => {
  reset();

  stubObjectives = [
    makeObjective({ userId: 'userGood' }),
    makeObjective({ userId: 'userBad'  }),
  ];
  stubUserMap['userGood'] = makeUser();
  stubUserMap['userBad']  = makeUser();

  // Make MetaSkillMastery.findOne throw for userBad
  let findOneCallCount = 0;
  codingModels.MetaSkillMastery.findOne = async ({ user_id }) => {
    findOneCallCount++;
    if (user_id === 'userBad') throw new Error('simulated DB error');
    return null; // userGood: no existing mastery
  };
  stubNotificationFindOne = null;

  const summary = await runBackfill({ logger: silentLogger });

  assert.strictEqual(summary.errors.length,  1,  'one error logged');
  assert.ok(summary.errors[0].error.includes('simulated DB error'));
  assert.strictEqual(summary.backfilled, 1, 'good user was still backfilled');

  // Restore clean stub
  codingModels.MetaSkillMastery.findOne = async () => stubMasteryFindOne;
});
