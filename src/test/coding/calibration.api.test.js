'use strict';

/**
 * Tests for calibration drill endpoints (Task 23):
 *   POST /api/coding/drills/calibration/start
 *   POST /api/coding/drills/calibration/:calibration_id/submit
 *   GET  /api/coding/drills/calibration/:calibration_id/result
 *
 * Strategy: direct controller invocation with stubbed require.cache modules.
 * Workers injected via _setWorkersModule test seam.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub-for-tests';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'stub-secret-for-tests';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

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
const DRILL_ATTEMPT_PATH = path.resolve(
  __dirname,
  '../../coding/models/drillAttempt.model.js'
);
const META_SKILL_PATH = path.resolve(
  __dirname,
  '../../coding/models/metaSkillMastery.model.js'
);
const DIFFICULTY_STATE_PATH = path.resolve(
  __dirname,
  '../../coding/models/difficultyState.model.js'
);
const USER_OBJECTIVE_PATH = path.resolve(__dirname, '../../models/UserObjective.js');

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

function stubCodingModels({ ArtifactBundle, DrillAttempt, MetaSkillMastery, DifficultyState }) {
  const indexExports = { ArtifactBundle, DrillAttempt, MetaSkillMastery, DifficultyState };
  stubModule(CODING_MODELS_INDEX_PATH, indexExports);
  if (ArtifactBundle)   stubModule(ARTIFACT_BUNDLE_PATH,  ArtifactBundle);
  if (DrillAttempt)     stubModule(DRILL_ATTEMPT_PATH,    DrillAttempt);
  if (MetaSkillMastery) stubModule(META_SKILL_PATH,       MetaSkillMastery);
  if (DifficultyState)  stubModule(DIFFICULTY_STATE_PATH, DifficultyState);
}

function loadController() {
  delete require.cache[CONTROLLER_PATH];
  return require(CONTROLLER_PATH);
}

function buildReqRes({ user = null, params = {}, body = {} } = {}) {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(payload) { this._body = payload; return this; },
  };
  const req = { user, params, body };
  return [req, res];
}

// ---------------------------------------------------------------------------
// Fake data factories
// ---------------------------------------------------------------------------

const FAKE_USER_ID  = '64f1a2b3c4d5e6f7a8b9c0d1';
const FAKE_CAL_ID   = 'cal-1234-5678-uuid';

function makeBundle(subtype) {
  return {
    _id: `bundle-${subtype}-id`,
    type: 'drill',
    drill_subtype: subtype,
    role_track: 'swe',
    difficulty: 'easy',
    language: 'python',
    brief: `Brief for ${subtype} drill`,
    time_budget_minutes: 20,
    acceptance_criteria: [`${subtype} criteria`],
    status: 'active',
    starter_repo: subtype === 'refactor' ? { files: [{ path: 'app.py', content: 'pass' }] } : null,
    visible_tests: subtype === 'refactor'
      ? [{ name: 'test_basic', command: 'pytest', expected_output_contains: 'PASSED' }]
      : [],
  };
}

const ALL_BUNDLES = {
  prompt: makeBundle('prompt'),
  verify: makeBundle('verify'),
  decompose: makeBundle('decompose'),
  refactor: makeBundle('refactor'),
};

const SUBTYPES = ['prompt', 'verify', 'decompose', 'refactor'];

function makeAttempt(subtype, overrides = {}) {
  return {
    _id: `attempt-${subtype}-id`,
    user_id: FAKE_USER_ID,
    bundle_id: `bundle-${subtype}-id`,
    drill_subtype: subtype,
    status: 'in_progress',
    started_at: new Date(Date.now() - 2 * 60 * 1000),
    is_calibration: true,
    calibration_id: FAKE_CAL_ID,
    calibration_committed: false,
    save: async function() { return this; },
    ...overrides,
  };
}

const VALID_SUBMISSIONS = {
  prompt: { drill_subtype: 'prompt', attempt_id: 'attempt-prompt-id', submission: { prompt_text: 'This is my detailed prompt answer with enough text.' } },
  verify: { drill_subtype: 'verify', attempt_id: 'attempt-verify-id', submission: { bug_locations: [{ file: 'app.py', line: 5, explanation: 'Null pointer is here in the code.' }] } },
  decompose: { drill_subtype: 'decompose', attempt_id: 'attempt-decompose-id', submission: { decomposition_steps: [{ step: 'Parse input', rationale: 'Need to validate' }, { step: 'Process', rationale: 'Core logic' }] } },
  refactor: { drill_subtype: 'refactor', attempt_id: 'attempt-refactor-id', submission: { refactored_code: { files: [{ path: 'app.py', content: 'def foo(): return 1' }] } } },
};

const FAKE_GRADE = {
  overall_score: 75,
  rubric_breakdown: [{ dimension: 'correctness', score: 75, feedback: 'OK' }],
  what_to_try_next: 'Practice more',
  integrity_confidence: 'high',
  graded_at: new Date('2026-05-26T12:00:00Z'),
};

// ---------------------------------------------------------------------------
// Helper: build the 4-element ArtifactBundle.findOne stub that returns
// a different bundle per subtype query. Called inside startCalibration:
// ArtifactBundle.findOne({ drill_subtype: X, ... }).sort(...).lean()
// ---------------------------------------------------------------------------

function makeBundleFinder(availableSubtypes) {
  return {
    findOne: (query) => {
      const subtype = query && query.drill_subtype;
      if (availableSubtypes.includes(subtype)) {
        return { sort: () => ({ lean: async () => ALL_BUNDLES[subtype] }) };
      }
      return { sort: () => ({ lean: async () => null }) };
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build stubbed DrillAttempt that tracks create() calls and stores
// a map of { calibration_id → [attempts] } for findOne/find queries.
// ---------------------------------------------------------------------------

function makeAttemptStore(existingAttempts = []) {
  const created = [];
  return {
    create: async (doc) => {
      const a = makeAttempt(doc.drill_subtype || 'prompt', {
        _id: `attempt-${doc.bundle_id || 'x'}-id`,
        ...doc,
        save: async function() { return this; },
      });
      created.push(a);
      return a;
    },
    find: (query) => {
      const calId = query && query.calibration_id;
      const uid   = query && query.user_id;
      const matching = [...existingAttempts, ...created].filter(a =>
        (!calId || a.calibration_id === String(calId)) &&
        (!uid   || String(a.user_id)  === String(uid))
      );
      return Promise.resolve(matching);
    },
    findOne: () => ({ sort: () => ({ lean: async () => null }) }),
    _created: created,
  };
}

// ---------------------------------------------------------------------------
// Test 1: startCalibration happy path
// ---------------------------------------------------------------------------

test('startCalibration: happy path — returns 4 easy bundles, one per subtype, all is_calibration', async () => {
  stubCodingModels({
    ArtifactBundle: makeBundleFinder(SUBTYPES),
    DrillAttempt: {
      create: async (doc) => makeAttempt(doc.drill_subtype, { ...doc, _id: `attempt-${doc.bundle_id}` }),
    },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: { findOne: async () => null, create: async () => null },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({
      lean: async () => ({
        userId: FAKE_USER_ID,
        canonicalTopic: 'software-engineer',
        isPrimary: true,
        status: 'active',
      }),
    }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  await ctrl.startCalibration(req, res);

  assert.strictEqual(res._status, 200);
  const body = res._body;
  assert.ok(body.calibration_id, 'should have calibration_id');
  assert.strictEqual(body.role_track, 'swe');
  assert.strictEqual(body.estimated_minutes, 8);
  assert.ok(Array.isArray(body.drills), 'drills should be array');
  assert.strictEqual(body.drills.length, 4, 'should have exactly 4 drills');

  const subtypesReturned = body.drills.map(d => d.drill_subtype).sort();
  assert.deepStrictEqual(subtypesReturned, ['decompose', 'prompt', 'refactor', 'verify']);

  for (const drill of body.drills) {
    assert.ok(drill.attempt_id, 'each drill must have attempt_id');
    assert.ok(drill.bundle_id, 'each drill must have bundle_id');
    assert.ok(drill.brief, 'each drill must have brief');
    assert.strictEqual(drill.time_budget_minutes, 2, 'time_budget overridden to 2 for calibration');
    // Secret fields must not be exposed
    assert.strictEqual(drill.reference_solution, undefined);
    assert.strictEqual(drill.hidden_tests, undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 2: startCalibration missing bundles → 503 calibration_unavailable
// ---------------------------------------------------------------------------

test('startCalibration: only 3 of 4 subtypes have bundles → 503 calibration_unavailable', async () => {
  // Only prompt, verify, decompose — missing refactor
  stubCodingModels({
    ArtifactBundle: makeBundleFinder(['prompt', 'verify', 'decompose']),
    DrillAttempt: { create: async () => { throw new Error('should not create'); } },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: { findOne: async () => null, create: async () => null },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({
      lean: async () => ({
        userId: FAKE_USER_ID,
        canonicalTopic: 'software-engineer',
        isPrimary: true,
        status: 'active',
      }),
    }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  await ctrl.startCalibration(req, res);

  assert.strictEqual(res._status, 503);
  assert.strictEqual(res._body.error, 'calibration_unavailable');
});

// ---------------------------------------------------------------------------
// Test 3: startCalibration user has no coding objective → 404
// ---------------------------------------------------------------------------

test('startCalibration: user has no coding objective → 404', async () => {
  stubCodingModels({
    ArtifactBundle: makeBundleFinder(SUBTYPES),
    DrillAttempt: { create: async () => { throw new Error('should not create'); } },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: { findOne: async () => null, create: async () => null },
  });
  stubModule(USER_OBJECTIVE_PATH, {
    findOne: () => ({ lean: async () => null }),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  await ctrl.startCalibration(req, res);

  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.error, 'no_coding_track_for_objective');
});

// ---------------------------------------------------------------------------
// Test 4: submitCalibration happy path — 4 submissions accepted, 4 jobs enqueued
// ---------------------------------------------------------------------------

test('submitCalibration: happy path — 4 valid submissions accepted, 4 grader jobs enqueued', async () => {
  const existingAttempts = SUBTYPES.map(s => makeAttempt(s));
  const enqueuedJobs = [];

  stubCodingModels({
    ArtifactBundle: makeBundleFinder(SUBTYPES),
    DrillAttempt: {
      find: (query) => {
        const calId = query && query.calibration_id;
        const uid   = query && query.user_id;
        return Promise.resolve(existingAttempts.filter(a =>
          (!calId || a.calibration_id === String(calId)) &&
          (!uid   || String(a.user_id) === String(uid))
        ));
      },
    },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: { findOne: async () => null },
  });

  const ctrl = loadController();
  ctrl._setWorkersModule({
    drillGraderQueue: {
      add: async (name, data) => {
        enqueuedJobs.push({ name, data });
        return { id: `job-${data.drill_subtype}` };
      },
    },
  });

  const [req, res] = buildReqRes({
    user: { userId: FAKE_USER_ID },
    params: { calibration_id: FAKE_CAL_ID },
    body: { submissions: Object.values(VALID_SUBMISSIONS) },
  });
  await ctrl.submitCalibration(req, res);

  assert.strictEqual(res._status, 202);
  assert.strictEqual(res._body.calibration_id, FAKE_CAL_ID);
  assert.strictEqual(res._body.status, 'submitted');
  assert.ok(res._body.poll_url.includes(FAKE_CAL_ID));

  assert.strictEqual(enqueuedJobs.length, 4, 'exactly 4 grader jobs should be enqueued');
  const enqueuedSubtypes = enqueuedJobs.map(j => j.data.drill_subtype).sort();
  assert.deepStrictEqual(enqueuedSubtypes, ['decompose', 'prompt', 'refactor', 'verify']);
});

// ---------------------------------------------------------------------------
// Test 5: submitCalibration partial submissions (only 3 of 4) → 400
// ---------------------------------------------------------------------------

test('submitCalibration: only 3 of 4 submissions provided → 400', async () => {
  const existingAttempts = SUBTYPES.map(s => makeAttempt(s));

  stubCodingModels({
    ArtifactBundle: makeBundleFinder(SUBTYPES),
    DrillAttempt: {
      find: (query) => {
        return Promise.resolve(existingAttempts.filter(a =>
          a.calibration_id === (query && query.calibration_id)
        ));
      },
    },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: { findOne: async () => null },
  });

  const ctrl = loadController();
  ctrl._setWorkersModule({ drillGraderQueue: { add: async () => {} } });

  const threeSubmissions = Object.values(VALID_SUBMISSIONS).slice(0, 3);
  const [req, res] = buildReqRes({
    user: { userId: FAKE_USER_ID },
    params: { calibration_id: FAKE_CAL_ID },
    body: { submissions: threeSubmissions },
  });
  await ctrl.submitCalibration(req, res);

  assert.strictEqual(res._status, 400);
  assert.strictEqual(res._body.error, 'invalid_submission_count');
});

// ---------------------------------------------------------------------------
// Test 6: submitCalibration invalid submission shape → 400
// ---------------------------------------------------------------------------

test('submitCalibration: invalid submission shape → 400', async () => {
  const existingAttempts = SUBTYPES.map(s => makeAttempt(s));

  stubCodingModels({
    ArtifactBundle: makeBundleFinder(SUBTYPES),
    DrillAttempt: {
      find: (query) => {
        return Promise.resolve(existingAttempts.filter(a =>
          a.calibration_id === (query && query.calibration_id)
        ));
      },
    },
    MetaSkillMastery: { findOne: () => ({ lean: async () => null }) },
    DifficultyState: { findOne: async () => null },
  });

  const ctrl = loadController();
  ctrl._setWorkersModule({ drillGraderQueue: { add: async () => {} } });

  // Replace prompt submission with an invalid one (missing prompt_text)
  const badSubmissions = [
    { drill_subtype: 'prompt', attempt_id: 'attempt-prompt-id', submission: {} }, // invalid: missing prompt_text
    VALID_SUBMISSIONS.verify,
    VALID_SUBMISSIONS.decompose,
    VALID_SUBMISSIONS.refactor,
  ];

  const [req, res] = buildReqRes({
    user: { userId: FAKE_USER_ID },
    params: { calibration_id: FAKE_CAL_ID },
    body: { submissions: badSubmissions },
  });
  await ctrl.submitCalibration(req, res);

  assert.strictEqual(res._status, 400);
  assert.strictEqual(res._body.error, 'invalid_submission');
});

// ---------------------------------------------------------------------------
// Test 7: getCalibrationResult all 4 graded → aggregate + writes Mastery + DifficultyState
// ---------------------------------------------------------------------------

test('getCalibrationResult: all 4 graded → 200 with aggregate + writes Mastery + DifficultyState', async () => {
  const gradedAttempts = SUBTYPES.map(s => makeAttempt(s, {
    status: 'graded',
    calibration_committed: false,
    drill_subtype: s,
    grade: { ...FAKE_GRADE, overall_score: 75 },
    save: async function() { return this; },
  }));

  let masteryUpsertCalled = null;
  let diffStateUpsertCalled = null;

  stubCodingModels({
    ArtifactBundle: makeBundleFinder(SUBTYPES),
    DrillAttempt: {
      find: (query) => {
        return Promise.resolve(gradedAttempts.filter(a =>
          a.calibration_id === (query && query.calibration_id)
        ));
      },
    },
    MetaSkillMastery: {
      findOne: () => ({ lean: async () => null }),
      findOneAndUpdate: async (filter, update, opts) => {
        masteryUpsertCalled = { filter, update, opts };
        return {};
      },
    },
    DifficultyState: {
      findOne: async () => null,
      findOneAndUpdate: async (filter, update, opts) => {
        diffStateUpsertCalled = { filter, update, opts };
        return {};
      },
    },
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({
    user: { userId: FAKE_USER_ID },
    params: { calibration_id: FAKE_CAL_ID },
  });
  await ctrl.getCalibrationResult(req, res);

  assert.strictEqual(res._status, 200);
  const body = res._body;
  assert.strictEqual(body.calibration_id, FAKE_CAL_ID);
  assert.strictEqual(body.status, 'graded');
  assert.ok(Array.isArray(body.drills), 'should have drills array');
  assert.strictEqual(body.drills.length, 4);
  assert.ok(body.baseline_axes, 'should have baseline_axes');
  assert.ok('prompting' in body.baseline_axes, 'axes should have prompting');
  assert.ok('verification' in body.baseline_axes, 'axes should have verification');
  assert.ok('decomposition' in body.baseline_axes, 'axes should have decomposition');
  assert.ok('refactoring' in body.baseline_axes, 'axes should have refactoring');
  assert.ok(['easy', 'medium', 'hard'].includes(body.recommended_difficulty));

  // Mastery and DifficultyState should have been written
  assert.ok(masteryUpsertCalled, 'MetaSkillMastery.findOneAndUpdate should have been called');
  assert.ok(diffStateUpsertCalled, 'DifficultyState.findOneAndUpdate should have been called');
});

// ---------------------------------------------------------------------------
// Test 8: getCalibrationResult partial graded → 202 with status='partial'
// ---------------------------------------------------------------------------

test('getCalibrationResult: only 2 of 4 graded → 202 with status=partial', async () => {
  // 2 graded, 2 still submitted
  const mixedAttempts = [
    makeAttempt('prompt',    { status: 'graded',    drill_subtype: 'prompt',    grade: FAKE_GRADE }),
    makeAttempt('verify',    { status: 'graded',    drill_subtype: 'verify',    grade: FAKE_GRADE }),
    makeAttempt('decompose', { status: 'submitted', drill_subtype: 'decompose', grade: null }),
    makeAttempt('refactor',  { status: 'submitted', drill_subtype: 'refactor',  grade: null }),
  ];

  stubCodingModels({
    ArtifactBundle: makeBundleFinder(SUBTYPES),
    DrillAttempt: {
      find: (query) => {
        return Promise.resolve(mixedAttempts.filter(a =>
          a.calibration_id === (query && query.calibration_id)
        ));
      },
    },
    MetaSkillMastery: {
      findOne: () => ({ lean: async () => null }),
      findOneAndUpdate: async () => { throw new Error('should not write mastery when partial'); },
    },
    DifficultyState: {
      findOne: async () => null,
      findOneAndUpdate: async () => { throw new Error('should not write difficulty when partial'); },
    },
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({
    user: { userId: FAKE_USER_ID },
    params: { calibration_id: FAKE_CAL_ID },
  });
  await ctrl.getCalibrationResult(req, res);

  assert.strictEqual(res._status, 202);
  const body = res._body;
  assert.strictEqual(body.calibration_id, FAKE_CAL_ID);
  assert.strictEqual(body.status, 'partial');
  assert.ok(Array.isArray(body.drills));
});
