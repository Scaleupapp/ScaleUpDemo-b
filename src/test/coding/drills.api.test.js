'use strict';

/**
 * Tests for GET /api/coding/drills/today
 *
 * Strategy: test the controller directly via req/res stubs (avoids dealing
 * with JWT auth middleware in integration). One supertest smoke-test confirms
 * the route is wired up (returns 401 when no token provided — auth middleware
 * fires before the controller).
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

// Resolve model paths once (so we can stub by absolute path)
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
// The coding models index re-exports all three above — stub it too so the
// controller's `require('../models')` destructuring gets fakes.
const CODING_MODELS_INDEX_PATH = path.resolve(
  __dirname,
  '../../coding/models/index.js'
);
const USER_PATH = path.resolve(__dirname, '../../models/User.js');
const USER_OBJECTIVE_PATH = path.resolve(__dirname, '../../models/UserObjective.js');

/**
 * Build a fake req/res pair.
 */
function buildReqRes({ user = null } = {}) {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(payload) { this._body = payload; return this; },
  };
  const req = { user };
  return [req, res];
}

/**
 * Load (or reload) the controller, using currently-stubs in require.cache.
 */
function loadController() {
  delete require.cache[CONTROLLER_PATH];
  return require(CONTROLLER_PATH);
}

/**
 * Stub all three coding models (index + individual files) in one call.
 * This ensures `require('../models')` in the controller gets fakes regardless
 * of whether the index was already cached.
 */
function stubCodingModels({ ArtifactBundle, MetaSkillMastery, DifficultyState }) {
  const indexExports = { ArtifactBundle, MetaSkillMastery, DifficultyState };

  stubModule(CODING_MODELS_INDEX_PATH, indexExports);
  if (ArtifactBundle) stubModule(ARTIFACT_BUNDLE_PATH, ArtifactBundle);
  if (MetaSkillMastery) stubModule(META_SKILL_PATH, MetaSkillMastery);
  if (DifficultyState) stubModule(DIFFICULTY_STATE_PATH, DifficultyState);
}

// ---------------------------------------------------------------------------
// Fake data factories
// ---------------------------------------------------------------------------

const FAKE_USER_ID = '64f1a2b3c4d5e6f7a8b9c0d1';

const FAKE_BUNDLE = {
  _id: 'bundle-abc-123',
  type: 'drill',
  drill_subtype: 'prompt',
  role_track: 'swe',
  difficulty: 'easy',
  language: 'javascript',
  brief: 'Write a function that adds two numbers.',
  time_budget_minutes: 20,
  acceptance_criteria: ['function exists', 'returns correct sum'],
  starter_repo: null,
};

// ---------------------------------------------------------------------------
// Test 1: 401 when req.user is null
// ---------------------------------------------------------------------------

test('drills/today controller: returns 401 when req.user is null', async () => {
  stubCodingModels({
    ArtifactBundle: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: { findOne: async () => null, create: async () => null },
  });
  stubModule(USER_OBJECTIVE_PATH, { findOne: () => ({ lean: async () => null }) });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: null });
  await ctrl.getToday(req, res);

  assert.strictEqual(res._status, 401);
  assert.strictEqual(res._body.error, 'unauthorized');
});

// ---------------------------------------------------------------------------
// Test 2: Happy path — swe user, no mastery (defaults to prompting), existing DifficultyState
// ---------------------------------------------------------------------------

test('drills/today controller: happy path returns 200 with bundle', async () => {
  const FAKE_DIFF_STATE = {
    user_id: FAKE_USER_ID,
    role_track: 'swe',
    current_difficulty: 'easy',
  };

  stubCodingModels({
    ArtifactBundle: {
      findOne: () => ({ sort: () => ({ lean: async () => FAKE_BUNDLE }) }),
    },
    MetaSkillMastery: {
      findOne: () => ({ lean: async () => null }),  // no mastery yet → defaults to prompting
    },
    DifficultyState: {
      findOne: async () => FAKE_DIFF_STATE,
      create: async () => { throw new Error('should not be called'); },
    },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({
      lean: async () => ({
        userId: FAKE_USER_ID,
        objectiveType: 'interview_preparation',
        canonicalTopic: 'software-engineer',
        isPrimary: true,
        status: 'active',
      }),
    }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  await ctrl.getToday(req, res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.bundle_id, FAKE_BUNDLE._id);
  assert.strictEqual(res._body.drill_subtype, 'prompt');
  assert.strictEqual(res._body.difficulty, 'easy');
  assert.strictEqual(res._body.role_track, 'swe');
  assert.ok(res._body.brief);
});

// ---------------------------------------------------------------------------
// Test 3: No coding-mapped objective → 404 no_coding_track_for_objective
// ---------------------------------------------------------------------------

test('drills/today controller: returns 404 no_coding_track_for_objective for placement', async () => {
  stubCodingModels({
    ArtifactBundle: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: { findOne: async () => null, create: async () => null },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({
      lean: async () => ({
        userId: FAKE_USER_ID,
        objectiveType: 'exam_preparation',
        canonicalTopic: 'gmat',  // gmat doesn't map to any role track
        isPrimary: true,
        status: 'active',
      }),
    }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  await ctrl.getToday(req, res);

  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.error, 'no_coding_track_for_objective');
});

// ---------------------------------------------------------------------------
// Test 4: No bundle available → 404 no_drill_available
// ---------------------------------------------------------------------------

test('drills/today controller: returns 404 no_drill_available when no bundle matches', async () => {
  const FAKE_DIFF_STATE = {
    user_id: FAKE_USER_ID,
    role_track: 'swe',
    current_difficulty: 'easy',
  };

  stubCodingModels({
    ArtifactBundle: {
      findOne: () => ({ sort: () => ({ lean: async () => null }) }),  // no bundle
    },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: {
      findOne: async () => FAKE_DIFF_STATE,
      create: async () => { throw new Error('should not be called'); },
    },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({
      lean: async () => ({
        userId: FAKE_USER_ID,
        objectiveType: 'interview_preparation',
        canonicalTopic: 'software-engineer',
        isPrimary: true,
        status: 'active',
      }),
    }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  await ctrl.getToday(req, res);

  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.error, 'no_drill_available');
  assert.strictEqual(res._body.role_track, 'swe');
  assert.strictEqual(res._body.difficulty, 'easy');
});

// ---------------------------------------------------------------------------
// Test 5: DifficultyState created when missing
// ---------------------------------------------------------------------------

test('drills/today controller: creates DifficultyState when none exists', async () => {
  let createCallArgs = null;

  const CREATED_STATE = {
    user_id: FAKE_USER_ID,
    role_track: 'swe',
    current_difficulty: 'easy',
  };

  stubCodingModels({
    ArtifactBundle: {
      findOne: () => ({ sort: () => ({ lean: async () => FAKE_BUNDLE }) }),
    },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: {
      findOne: async () => null,  // not found → should trigger create
      create: async (doc) => {
        createCallArgs = doc;
        return CREATED_STATE;
      },
    },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({
      lean: async () => ({
        userId: FAKE_USER_ID,
        objectiveType: 'interview_preparation',
        canonicalTopic: 'software-engineer',
        isPrimary: true,
        status: 'active',
      }),
    }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  await ctrl.getToday(req, res);

  // DifficultyState.create was called
  assert.ok(createCallArgs, 'DifficultyState.create should have been called');
  assert.strictEqual(createCallArgs.current_difficulty, 'easy');
  assert.strictEqual(createCallArgs.role_track, 'swe');

  // Response still 200
  assert.strictEqual(res._status, 200);
});

// ---------------------------------------------------------------------------
// Test 6: No objective at all → 404 no_coding_track_for_objective
// ---------------------------------------------------------------------------

test('drills/today controller: returns 404 when user has no active primary objective', async () => {
  stubCodingModels({
    ArtifactBundle: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: { findOne: async () => null, create: async () => null },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => null }),  // no objective
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  await ctrl.getToday(req, res);

  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.error, 'no_coding_track_for_objective');
});

// ---------------------------------------------------------------------------
// Test 7: mastery with a clear weakest axis drives drill_subtype selection
// ---------------------------------------------------------------------------

test('drills/today controller: picks weakest axis from mastery for drill_subtype', async () => {
  const FAKE_DIFF_STATE = {
    user_id: FAKE_USER_ID,
    role_track: 'ds',
    current_difficulty: 'medium',
  };

  const FAKE_DS_BUNDLE = { ...FAKE_BUNDLE, role_track: 'ds', difficulty: 'medium', drill_subtype: 'verify' };

  stubCodingModels({
    ArtifactBundle: {
      findOne: () => ({ sort: () => ({ lean: async () => FAKE_DS_BUNDLE }) }),
    },
    MetaSkillMastery: {
      findOne: () => ({
        lean: async () => ({
          user_id: FAKE_USER_ID,
          role_track: 'ds',
          axes: { prompting: 80, verification: 20, decomposition: 90, refactoring: 70 },
        }),
      }),
    },
    DifficultyState: {
      findOne: async () => FAKE_DIFF_STATE,
      create: async () => { throw new Error('should not be called'); },
    },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({
      lean: async () => ({
        userId: FAKE_USER_ID,
        objectiveType: 'interview_preparation',
        canonicalTopic: 'data-scientist',
        isPrimary: true,
        status: 'active',
      }),
    }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  await ctrl.getToday(req, res);

  assert.strictEqual(res._status, 200);
  // verification is weakest → drill_subtype should be 'verify'
  assert.strictEqual(res._body.drill_subtype, 'verify');
  assert.strictEqual(res._body.role_track, 'ds');
});

// ---------------------------------------------------------------------------
// Supertest smoke test: route is wired and auth middleware fires
// ---------------------------------------------------------------------------

test('GET /api/coding/drills/today: returns 401 without auth token', async () => {
  const request = require('supertest');
  const app = require('../../app');
  const res = await request(app).get('/api/coding/drills/today');
  // Auth middleware returns 401 (possibly wrapped in error envelope)
  assert.strictEqual(res.status, 401);
});
