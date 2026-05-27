'use strict';

/**
 * Tests for POST /api/coding/drills/request (requestDrill controller)
 *
 * Strategy: test the controller directly via req/res stubs, same pattern as
 * drills.api.test.js. Avoids JWT middleware and DB connections.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub-for-tests';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'stub-secret-for-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function stubModule(absolutePath, stub) {
  delete require.cache[absolutePath];
  require.cache[absolutePath] = {
    id: absolutePath,
    filename: absolutePath,
    loaded: true,
    exports: stub,
  };
}

const CONTROLLER_PATH = path.resolve(
  __dirname,
  '../../coding/controllers/drills.controller.js'
);

const CODING_MODELS_INDEX_PATH = path.resolve(
  __dirname,
  '../../coding/models/index.js'
);
const ARTIFACT_BUNDLE_PATH = path.resolve(
  __dirname,
  '../../coding/models/artifactBundle.model.js'
);
const META_SKILL_PATH = path.resolve(
  __dirname,
  '../../coding/models/metaSkillMastery.model.js'
);
const DIFFICULTY_STATE_PATH = path.resolve(
  __dirname,
  '../../coding/models/difficultyState.model.js'
);
const DRILL_ATTEMPT_PATH = path.resolve(
  __dirname,
  '../../coding/models/drillAttempt.model.js'
);
const USER_OBJECTIVE_PATH = path.resolve(__dirname, '../../models/UserObjective.js');

function buildReqRes({ user = null, body = {} } = {}) {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(payload) { this._body = payload; return this; },
  };
  const req = { user, body };
  return [req, res];
}

function loadController() {
  delete require.cache[CONTROLLER_PATH];
  return require(CONTROLLER_PATH);
}

/**
 * Stub all coding models (index + individual files).
 */
/**
 * Build a chainable DrillAttempt stub that supports:
 *   DrillAttempt.find(query).select('bundle_id').lean()
 * by returning an object with a select() that returns { lean: async () => results }.
 */
function makeChainableDrillAttemptStub(results = []) {
  return {
    countDocuments: async () => 0,
    find: () => ({
      select: () => ({ lean: async () => results }),
    }),
    create: async (data) => ({ _id: 'attempt-new-123', ...data }),
  };
}

function stubCodingModels({ ArtifactBundle, MetaSkillMastery, DifficultyState, DrillAttempt } = {}) {
  const drillAttemptStub = DrillAttempt || makeChainableDrillAttemptStub([]);
  const indexExports = {
    ArtifactBundle: ArtifactBundle || { findOne: () => ({ lean: async () => null }) },
    MetaSkillMastery: MetaSkillMastery || { findOne: () => ({ lean: async () => null }) },
    DifficultyState: DifficultyState || { findOne: () => ({ lean: async () => null }) },
    DrillAttempt: drillAttemptStub,
  };
  stubModule(CODING_MODELS_INDEX_PATH, indexExports);
  if (ArtifactBundle) stubModule(ARTIFACT_BUNDLE_PATH, ArtifactBundle);
  if (MetaSkillMastery) stubModule(META_SKILL_PATH, MetaSkillMastery);
  if (DifficultyState) stubModule(DIFFICULTY_STATE_PATH, DifficultyState);
  stubModule(DRILL_ATTEMPT_PATH, drillAttemptStub);
}

// ---------------------------------------------------------------------------
// Fake data
// ---------------------------------------------------------------------------

const FAKE_USER_ID = '64f1a2b3c4d5e6f7a8b9c0d1';

const FAKE_OBJECTIVE = {
  userId: FAKE_USER_ID,
  status: 'active',
  isPrimary: true,
  canonicalTopic: 'software-engineer',
  objectiveType: 'career',
  specifics: { targetRole: 'SWE' },
};

const FAKE_MASTERY = {
  user_id: FAKE_USER_ID,
  role_track: 'swe',
  axes: { prompting: 80, verification: 55, decomposition: 70, refactoring: 0 },
};

const FAKE_DIFF_STATE = {
  user_id: FAKE_USER_ID,
  role_track: 'swe',
  current_difficulty: 'medium',
};

function makeBundle(overrides = {}) {
  return {
    _id: 'bundle-req-001',
    type: 'drill',
    drill_subtype: 'verify',
    role_track: 'swe',
    difficulty: 'medium',
    language: 'javascript',
    brief: 'Find the bug in this binary search implementation.',
    time_budget_minutes: 20,
    acceptance_criteria: ['bug located', 'explanation correct'],
    starter_repo: null,
    status: 'active',
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: Happy path — no body → picks weakest axis + current difficulty → 200
// ---------------------------------------------------------------------------

test('requestDrill: happy path (no body) picks weakest axis + current difficulty → 200', async () => {
  stubCodingModels({
    MetaSkillMastery: { findOne: () => ({ lean: async () => FAKE_MASTERY }) },
    DifficultyState: { findOne: () => ({ lean: async () => FAKE_DIFF_STATE }) },
    ArtifactBundle: {
      findOne: (query) => ({
        lean: async () => makeBundle({ drill_subtype: query.drill_subtype || 'verify', difficulty: query.difficulty || 'medium' }),
        sort: () => ({ lean: async () => makeBundle({ drill_subtype: query.drill_subtype || 'verify', difficulty: query.difficulty || 'medium' }) }),
      }),
    },
    DrillAttempt: {
      find: () => ({ select: () => ({ lean: async () => [] }) }),
      create: async (data) => ({ _id: 'attempt-x-001', ...data }),
    },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => FAKE_OBJECTIVE }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, body: {} });
  await ctrl.requestDrill(req, res);

  assert.strictEqual(res._status, 200);
  assert.ok(res._body.attempt_id, 'should have attempt_id');
  assert.ok(res._body.bundle_id, 'should have bundle_id');
  assert.ok(res._body.brief, 'should have brief');
  assert.ok(['prompt', 'verify', 'decompose'].includes(res._body.drill_subtype), 'drill_subtype should be Phase A');
});

// ---------------------------------------------------------------------------
// Test 2: Specific subtype — body { drill_subtype: 'verify' } → verify bundle
// ---------------------------------------------------------------------------

test('requestDrill: body { drill_subtype: "verify" } returns a verify bundle', async () => {
  const verifyBundle = makeBundle({ drill_subtype: 'verify', difficulty: 'easy' });
  stubCodingModels({
    MetaSkillMastery: { findOne: () => ({ lean: async () => FAKE_MASTERY }) },
    DifficultyState: { findOne: () => ({ lean: async () => FAKE_DIFF_STATE }) },
    ArtifactBundle: {
      findOne: (query) => ({
        lean: async () => (query.drill_subtype === 'verify' ? verifyBundle : null),
        sort: () => ({ lean: async () => (query.drill_subtype === 'verify' ? verifyBundle : null) }),
      }),
    },
    DrillAttempt: {
      find: () => ({ select: () => ({ lean: async () => [] }) }),
      create: async (data) => ({ _id: 'attempt-v-001', ...data }),
    },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => FAKE_OBJECTIVE }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, body: { drill_subtype: 'verify' } });
  await ctrl.requestDrill(req, res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.drill_subtype, 'verify');
});

// ---------------------------------------------------------------------------
// Test 3: Specific difficulty — body { difficulty: 'hard' } → hard bundle
// ---------------------------------------------------------------------------

test('requestDrill: body { difficulty: "hard" } returns a hard bundle', async () => {
  const hardBundle = makeBundle({ drill_subtype: 'verify', difficulty: 'hard' });
  stubCodingModels({
    MetaSkillMastery: { findOne: () => ({ lean: async () => FAKE_MASTERY }) },
    DifficultyState: { findOne: () => ({ lean: async () => FAKE_DIFF_STATE }) },
    ArtifactBundle: {
      findOne: (query) => ({
        lean: async () => (query.difficulty === 'hard' ? hardBundle : null),
        sort: () => ({ lean: async () => (query.difficulty === 'hard' ? hardBundle : null) }),
      }),
    },
    DrillAttempt: {
      find: () => ({ select: () => ({ lean: async () => [] }) }),
      create: async (data) => ({ _id: 'attempt-h-001', ...data }),
    },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => FAKE_OBJECTIVE }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, body: { difficulty: 'hard' } });
  await ctrl.requestDrill(req, res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.difficulty, 'hard');
});

// ---------------------------------------------------------------------------
// Test 4: Invalid subtype → 400
// ---------------------------------------------------------------------------

test('requestDrill: invalid drill_subtype "refactor" → 400 (Phase A disallows refactor)', async () => {
  stubCodingModels({});
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => FAKE_OBJECTIVE }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, body: { drill_subtype: 'refactor' } });
  await ctrl.requestDrill(req, res);

  assert.strictEqual(res._status, 400);
  assert.strictEqual(res._body.error, 'invalid_drill_subtype');
  assert.ok(Array.isArray(res._body.allowed));
  assert.ok(!res._body.allowed.includes('refactor'));
});

// ---------------------------------------------------------------------------
// Test 5: Invalid difficulty → 400
// ---------------------------------------------------------------------------

test('requestDrill: invalid difficulty "impossible" → 400', async () => {
  stubCodingModels({});
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => FAKE_OBJECTIVE }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, body: { difficulty: 'impossible' } });
  await ctrl.requestDrill(req, res);

  assert.strictEqual(res._status, 400);
  assert.strictEqual(res._body.error, 'invalid_difficulty');
});

// ---------------------------------------------------------------------------
// Test 6: Non-coding user → 404 no_coding_track_for_objective
// ---------------------------------------------------------------------------

test('requestDrill: user with non-coding objective → 404 no_coding_track_for_objective', async () => {
  stubCodingModels({});
  // Objective maps to a non-coding topic
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => ({
      userId: FAKE_USER_ID,
      status: 'active',
      isPrimary: true,
      canonicalTopic: 'marketing',  // no coding track
      objectiveType: 'career',
    }) }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, body: {} });
  await ctrl.requestDrill(req, res);

  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.error, 'no_coding_track_for_objective');
});

// ---------------------------------------------------------------------------
// Test 7: No bundles available → 404 no_drill_available
// ---------------------------------------------------------------------------

test('requestDrill: no bundles available anywhere → 404 no_drill_available', async () => {
  stubCodingModels({
    MetaSkillMastery: { findOne: () => ({ lean: async () => FAKE_MASTERY }) },
    DifficultyState: { findOne: () => ({ lean: async () => FAKE_DIFF_STATE }) },
    ArtifactBundle: {
      findOne: () => ({
        lean: async () => null,
        sort: () => ({ lean: async () => null }),
      }),
    },
    DrillAttempt: {
      find: () => ({ select: () => ({ lean: async () => [] }) }),
      create: async (data) => ({ _id: 'attempt-none-001', ...data }),
    },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => FAKE_OBJECTIVE }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, body: { drill_subtype: 'prompt', difficulty: 'easy' } });
  await ctrl.requestDrill(req, res);

  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.error, 'no_drill_available');
  assert.ok(res._body.role_track, 'should report role_track');
  assert.ok(res._body.difficulty, 'should report difficulty');
  assert.ok(res._body.drill_subtype, 'should report drill_subtype');
});

// ---------------------------------------------------------------------------
// Test 8: Recent bundle exclusion — recentAttempts includes bundle_id so
//         the initial query excludes it, falling through to last-resort.
// ---------------------------------------------------------------------------

test('requestDrill: recent attempt exclusion causes fallback to last-resort query', async () => {
  const EXCLUDED_BUNDLE_ID = 'bundle-old-excluded-999';
  const FALLBACK_BUNDLE = makeBundle({ _id: 'bundle-fallback-001', drill_subtype: 'prompt', difficulty: 'easy' });

  let queryCallCount = 0;
  stubCodingModels({
    MetaSkillMastery: { findOne: () => ({ lean: async () => FAKE_MASTERY }) },
    DifficultyState: { findOne: () => ({ lean: async () => FAKE_DIFF_STATE }) },
    ArtifactBundle: {
      findOne: (query) => {
        queryCallCount += 1;
        // First two calls (with $nin exclusion) return null — simulates all non-excluded bundles missing.
        // Third call (last-resort, no $nin) returns the fallback.
        const hasExclusion = query._id && query._id.$nin;
        return {
          lean: async () => (hasExclusion ? null : FALLBACK_BUNDLE),
          sort: () => ({ lean: async () => (hasExclusion ? null : FALLBACK_BUNDLE) }),
        };
      },
    },
    DrillAttempt: {
      find: () => ({ select: () => ({ lean: async () => [{ bundle_id: EXCLUDED_BUNDLE_ID }] }) }),
      create: async (data) => ({ _id: 'attempt-fallback-001', ...data }),
    },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => FAKE_OBJECTIVE }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, body: { drill_subtype: 'prompt', difficulty: 'easy' } });
  await ctrl.requestDrill(req, res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.bundle_id, FALLBACK_BUNDLE._id, 'should return last-resort fallback bundle');
  // At least 2 ArtifactBundle.findOne calls — first with exclusion (returns null), then last-resort (returns bundle)
  assert.ok(queryCallCount >= 2, `expected >= 2 ArtifactBundle.findOne calls, got ${queryCallCount}`);
});

// ---------------------------------------------------------------------------
// Test 9: 401 when req.user is null
// ---------------------------------------------------------------------------

test('requestDrill: returns 401 when req.user is null', async () => {
  stubCodingModels({});
  stubModule(USER_OBJECTIVE_PATH, { findOne: () => ({ lean: async () => null }) });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: null, body: {} });
  await ctrl.requestDrill(req, res);

  assert.strictEqual(res._status, 401);
  assert.strictEqual(res._body.error, 'unauthorized');
});

// ---------------------------------------------------------------------------
// Test 10: attempt is flagged is_user_requested: true
// ---------------------------------------------------------------------------

test('requestDrill: created attempt has is_user_requested: true', async () => {
  let createdData = null;
  const bundle = makeBundle({ drill_subtype: 'decompose', difficulty: 'easy' });
  stubCodingModels({
    MetaSkillMastery: { findOne: () => ({ lean: async () => FAKE_MASTERY }) },
    DifficultyState: { findOne: () => ({ lean: async () => ({ ...FAKE_DIFF_STATE, current_difficulty: 'easy' }) }) },
    ArtifactBundle: {
      findOne: () => ({
        lean: async () => bundle,
        sort: () => ({ lean: async () => bundle }),
      }),
    },
    DrillAttempt: {
      find: () => ({ select: () => ({ lean: async () => [] }) }),
      create: async (data) => {
        createdData = data;
        return { _id: 'attempt-ir-001', ...data };
      },
    },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => FAKE_OBJECTIVE }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, body: { drill_subtype: 'decompose', difficulty: 'easy' } });
  await ctrl.requestDrill(req, res);

  assert.strictEqual(res._status, 200);
  assert.ok(createdData, 'DrillAttempt.create should have been called');
  assert.strictEqual(createdData.is_user_requested, true, 'attempt should be flagged is_user_requested: true');
  assert.strictEqual(createdData.is_calibration, false, 'attempt should not be a calibration');
});
