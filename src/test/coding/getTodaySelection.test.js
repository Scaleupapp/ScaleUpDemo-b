'use strict';
/**
 * Wave 4 block 3 — getToday selection hygiene.
 *
 *  - seededShuffle: deterministic, non-mutating, seed-sensitive.
 *  - getToday excludes bundles the user attempted in the last 7 days
 *    (_id.$nin passed to ArtifactBundle.find).
 *  - getToday selects deterministically among the eligible pool (same user+day
 *    ⇒ same pick; the pick equals seededShuffle(pool, seed)[0]).
 */
require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub-for-tests';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'stub-secret-for-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function stubModule(absolutePath, stub) {
  delete require.cache[absolutePath];
  require.cache[absolutePath] = { id: absolutePath, filename: absolutePath, loaded: true, exports: stub };
}

const CONTROLLER_PATH = path.resolve(__dirname, '../../coding/controllers/drills.controller.js');
const ARTIFACT_BUNDLE_PATH = path.resolve(__dirname, '../../coding/models/artifactBundle.model.js');
const META_SKILL_PATH = path.resolve(__dirname, '../../coding/models/metaSkillMastery.model.js');
const DIFFICULTY_STATE_PATH = path.resolve(__dirname, '../../coding/models/difficultyState.model.js');
const DRILL_ATTEMPT_PATH = path.resolve(__dirname, '../../coding/models/drillAttempt.model.js');
const CODING_MODELS_INDEX_PATH = path.resolve(__dirname, '../../coding/models/index.js');
const USER_OBJECTIVE_PATH = path.resolve(__dirname, '../../models/UserObjective.js');

const FAKE_USER_ID = '64f1a2b3c4d5e6f7a8b9c0d1';

function loadController() {
  delete require.cache[CONTROLLER_PATH];
  return require(CONTROLLER_PATH);
}

function buildReqRes(user) {
  const res = {
    _status: 200, _body: null,
    status(c) { this._status = c; return this; },
    json(p) { this._body = p; return this; },
  };
  return [{ user }, res];
}

function bundle(id, extra = {}) {
  return {
    _id: id, type: 'drill', drill_subtype: 'prompt', role_track: 'swe', difficulty: 'easy',
    language: 'javascript', brief: `brief ${id}`, time_budget_minutes: 20, acceptance_criteria: [], starter_repo: null, ...extra,
  };
}

function installStubs({ pool, recentBundleIds = [], captureFindQueries }) {
  const ArtifactBundle = {
    findOne: () => ({ sort: () => ({ lean: async () => null }) }),
    find: (query) => {
      if (captureFindQueries) captureFindQueries.push(query);
      // Only return the pool for the exact-subtype eligible query (has _id.$nin);
      // the no-exclusion last-resort query returns the same pool.
      const excluded = new Set((query._id && query._id.$nin ? query._id.$nin : []).map(String));
      const eligible = pool.filter((b) => !excluded.has(String(b._id)));
      return { lean: async () => eligible };
    },
  };
  const MetaSkillMastery = {
    findOne: () => ({ lean: async () => ({ user_id: FAKE_USER_ID, role_track: 'swe', axes: { prompting: 60, verification: 80, decomposition: 70, refactoring: 50 } }) }),
  };
  const DifficultyState = {
    findOne: async () => ({ user_id: FAKE_USER_ID, role_track: 'swe', current_difficulty: 'easy' }),
    create: async () => { throw new Error('should not create'); },
  };
  const DrillAttempt = {
    countDocuments: async () => 0,
    find: () => ({ select: () => ({ lean: async () => recentBundleIds.map((id) => ({ bundle_id: id })) }) }),
  };
  const index = { ArtifactBundle, MetaSkillMastery, DifficultyState, DrillAttempt };
  stubModule(CODING_MODELS_INDEX_PATH, index);
  stubModule(ARTIFACT_BUNDLE_PATH, ArtifactBundle);
  stubModule(META_SKILL_PATH, MetaSkillMastery);
  stubModule(DIFFICULTY_STATE_PATH, DifficultyState);
  stubModule(DRILL_ATTEMPT_PATH, DrillAttempt);
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => ({ userId: FAKE_USER_ID, objectiveType: 'interview_preparation', canonicalTopic: 'software-engineer', isPrimary: true, status: 'active' }) }),
  });
}

// ── seededShuffle (pure) ───────────────────────────────────────────────────────

test('seededShuffle: deterministic, seed-sensitive, non-mutating', () => {
  const { seededShuffle } = loadController();
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  const a1 = seededShuffle(arr, 'user1:2026-07-11');
  const a2 = seededShuffle(arr, 'user1:2026-07-11');
  const a3 = seededShuffle(arr, 'user2:2026-07-11');
  assert.deepEqual(a1, a2, 'same seed ⇒ same order');
  assert.notDeepEqual(a1, a3, 'different seed ⇒ different order');
  assert.deepEqual(arr, [1, 2, 3, 4, 5, 6, 7, 8], 'input array is not mutated');
  assert.deepEqual([...a1].sort((x, y) => x - y), arr, 'shuffle is a permutation');
});

// ── recent-exclusion ───────────────────────────────────────────────────────────

test('getToday: excludes bundles attempted in the last 7 days (_id.$nin)', async () => {
  const captureFindQueries = [];
  installStubs({ pool: [bundle('b1'), bundle('b2')], recentBundleIds: ['b1'], captureFindQueries });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ userId: FAKE_USER_ID });
  await ctrl.getToday(req, res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.bundle_id, 'b2', 'must not serve the recently-attempted b1');
  const eligibleQuery = captureFindQueries.find((q) => q._id && q._id.$nin);
  assert.ok(eligibleQuery, 'the eligible query must carry an _id.$nin exclusion');
  assert.deepEqual(eligibleQuery._id.$nin.map(String), ['b1']);
});

// ── deterministic pick among the eligible pool ─────────────────────────────────

test('getToday: picks deterministically among eligible bundles (= seededShuffle[0])', async () => {
  const pool = [bundle('p1'), bundle('p2'), bundle('p3'), bundle('p4')];

  installStubs({ pool: pool.map((b) => ({ ...b })) });
  const ctrl = loadController();
  const daySeed = `${FAKE_USER_ID}:${new Date(new Date().setHours(0, 0, 0, 0)).toISOString().slice(0, 10)}`;
  const expected = ctrl.seededShuffle(pool, daySeed)[0]._id;

  const [req1, res1] = buildReqRes({ userId: FAKE_USER_ID });
  await ctrl.getToday(req1, res1);
  const [req2, res2] = buildReqRes({ userId: FAKE_USER_ID });
  await ctrl.getToday(req2, res2);

  assert.strictEqual(res1._body.bundle_id, expected, 'pick must equal the seeded-shuffle head');
  assert.strictEqual(res2._body.bundle_id, res1._body.bundle_id, 'same user+day ⇒ same drill');
});

test('getToday: last-resort drops the exclusion when every bundle was recently attempted', async () => {
  // Pool of one, and that one was recently attempted → eligible set empties, so
  // the no-exclusion fallback still returns it rather than 404.
  installStubs({ pool: [bundle('only1')], recentBundleIds: ['only1'] });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ userId: FAKE_USER_ID });
  await ctrl.getToday(req, res);
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.bundle_id, 'only1');
});
