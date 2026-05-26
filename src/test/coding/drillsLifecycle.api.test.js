'use strict';

/**
 * Tests for T22 lifecycle endpoints:
 *   POST /api/coding/drills/:id/start
 *   POST /api/coding/drills/:id/submit
 *   GET  /api/coding/drills/:id/result
 *
 * Strategy: direct controller invocation with stubbed require.cache modules.
 * The workers module is injected via a test-seam exported by the controller
 * (`_setWorkersModule`).
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
  if (ArtifactBundle)  stubModule(ARTIFACT_BUNDLE_PATH,  ArtifactBundle);
  if (DrillAttempt)    stubModule(DRILL_ATTEMPT_PATH,    DrillAttempt);
  if (MetaSkillMastery) stubModule(META_SKILL_PATH,      MetaSkillMastery);
  if (DifficultyState) stubModule(DIFFICULTY_STATE_PATH, DifficultyState);
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
const FAKE_BUNDLE_ID = 'bundle-abc-123';
const FAKE_ATTEMPT_ID = 'attempt-xyz-456';

const FAKE_BUNDLE_PROMPT = {
  _id: FAKE_BUNDLE_ID,
  type: 'drill',
  drill_subtype: 'prompt',
  role_track: 'swe',
  difficulty: 'easy',
  language: 'python',
  brief: 'Write a function that reverses a string.',
  time_budget_minutes: 10,
  acceptance_criteria: ['function exists', 'returns reversed string'],
  status: 'active',
  reference_solution: 'def reverse(s): return s[::-1]',
  hidden_tests: [{ name: 'hidden', command: 'pytest hidden_test.py' }],
  seeded_mistakes: null,
  rubric_anchors: [],
  expected_meta_skill_signals: [],
  difficulty_signals: [],
  content_hash: 'abc123',
  generated_by: 'claude-opus-4',
  starter_repo: null,
  visible_tests: [],
};

const FAKE_BUNDLE_REFACTOR = {
  ...FAKE_BUNDLE_PROMPT,
  drill_subtype: 'refactor',
  starter_repo: { files: [{ path: 'app.py', content: 'def foo(): pass' }] },
  visible_tests: [
    { name: 'test_basic', command: 'pytest test_basic.py', expected_output_contains: 'PASSED' },
    { name: 'test_edge',  command: 'pytest test_edge.py',  expected_output_contains: 'PASSED' },
  ],
};

const FAKE_ATTEMPT_IN_PROGRESS = {
  _id: FAKE_ATTEMPT_ID,
  user_id: FAKE_USER_ID,
  bundle_id: FAKE_BUNDLE_ID,
  status: 'in_progress',
  started_at: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
  is_calibration: false,
  save: async function() { return this; },
};

const FAKE_GRADE = {
  overall_score: 82,
  rubric_breakdown: [{ dimension: 'correctness', score: 90, feedback: 'Good' }],
  what_to_try_next: 'Try edge cases',
  integrity_confidence: 'high',
  graded_at: new Date('2026-05-26T12:00:00Z'),
};

const VALID_PROMPT_SUBMISSION = {
  drill_subtype: 'prompt',
  submission: { prompt_text: 'This is my prompt response with enough detail.' },
};

// ---------------------------------------------------------------------------
// ============================================================
// startDrill tests
// ============================================================
// ---------------------------------------------------------------------------

test('startDrill: returns 401 when req.user is null', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: async () => null },
    DrillAttempt: { countDocuments: async () => 0, create: async () => null },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: null, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.startDrill(req, res);
  assert.strictEqual(res._status, 401);
  assert.strictEqual(res._body.error, 'unauthorized');
});

test('startDrill: returns 404 when bundle not found', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => null }) },
    DrillAttempt: { countDocuments: async () => 0, create: async () => null },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.startDrill(req, res);
  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.error, 'bundle_not_found');
});

test('startDrill: returns 404 when bundle status is not active', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => ({ ...FAKE_BUNDLE_PROMPT, status: 'draft' }) }) },
    DrillAttempt: { countDocuments: async () => 0, create: async () => null },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.startDrill(req, res);
  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.error, 'bundle_not_found');
});

test('startDrill: returns 429 daily_quota_exceeded when user has used drill today', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: { countDocuments: async () => 1, create: async () => { throw new Error('should not create'); } },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.startDrill(req, res);
  assert.strictEqual(res._status, 429);
  assert.strictEqual(res._body.error, 'daily_quota_exceeded');
  assert.strictEqual(res._body.limit, 1);
});

test('startDrill: happy path returns safe bundle view with attempt_id, no secret fields', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: {
      countDocuments: async () => 0,
      create: async () => ({ _id: FAKE_ATTEMPT_ID }),
    },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.startDrill(req, res);

  assert.strictEqual(res._status, 200);
  const body = res._body;
  assert.strictEqual(body.attempt_id, FAKE_ATTEMPT_ID);
  assert.strictEqual(body.bundle_id, FAKE_BUNDLE_ID);
  assert.strictEqual(body.brief, FAKE_BUNDLE_PROMPT.brief);
  assert.strictEqual(body.time_budget_minutes, 10);
  assert.strictEqual(body.drill_subtype, 'prompt');
  assert.strictEqual(body.difficulty, 'easy');
  assert.strictEqual(body.role_track, 'swe');
  assert.strictEqual(body.language, 'python');
  assert.ok(Array.isArray(body.acceptance_criteria));

  // Secret fields must NOT be present
  assert.strictEqual(body.reference_solution, undefined);
  assert.strictEqual(body.hidden_tests, undefined);
  assert.strictEqual(body.seeded_mistakes, undefined);
  assert.strictEqual(body.rubric_anchors, undefined);
  assert.strictEqual(body.expected_meta_skill_signals, undefined);
  assert.strictEqual(body.difficulty_signals, undefined);
  assert.strictEqual(body.content_hash, undefined);
  assert.strictEqual(body.generated_by, undefined);

  // prompt drill should not include starter_repo or visible_tests
  assert.strictEqual(body.starter_repo, undefined);
  assert.strictEqual(body.visible_tests, undefined);
});

test('startDrill: refactor bundle includes starter_repo and sanitized visible_tests (no expected_output_contains)', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_REFACTOR }) },
    DrillAttempt: {
      countDocuments: async () => 0,
      create: async () => ({ _id: FAKE_ATTEMPT_ID }),
    },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.startDrill(req, res);

  assert.strictEqual(res._status, 200);
  const body = res._body;
  assert.ok(body.starter_repo, 'starter_repo should be present for refactor');
  assert.ok(Array.isArray(body.visible_tests), 'visible_tests should be array');
  assert.strictEqual(body.visible_tests.length, 2);

  // Each visible test should have name and command but NOT expected_output_contains
  for (const vt of body.visible_tests) {
    assert.ok(vt.name);
    assert.ok(vt.command);
    assert.strictEqual(vt.expected_output_contains, undefined);
  }
});

// ---------------------------------------------------------------------------
// ============================================================
// submitDrill tests
// ============================================================
// ---------------------------------------------------------------------------

test('submitDrill: returns 401 when req.user is null', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: { findOne: () => ({ sort: async () => null }) },
  });
  const ctrl = loadController();
  ctrl._setWorkersModule({ drillGraderQueue: { add: async () => {} } });
  const [req, res] = buildReqRes({
    user: null,
    params: { id: FAKE_BUNDLE_ID },
    body: VALID_PROMPT_SUBMISSION,
  });
  await ctrl.submitDrill(req, res);
  assert.strictEqual(res._status, 401);
  assert.strictEqual(res._body.error, 'unauthorized');
});

test('submitDrill: returns 400 for invalid submission (missing prompt_text)', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: { findOne: () => ({ sort: async () => null }) },
  });
  const ctrl = loadController();
  ctrl._setWorkersModule({ drillGraderQueue: { add: async () => {} } });
  const [req, res] = buildReqRes({
    user: { userId: FAKE_USER_ID },
    params: { id: FAKE_BUNDLE_ID },
    body: { drill_subtype: 'prompt', submission: {} },  // missing prompt_text
  });
  await ctrl.submitDrill(req, res);
  assert.strictEqual(res._status, 400);
  assert.strictEqual(res._body.error, 'invalid_submission');
});

test('submitDrill: returns 400 for subtype_mismatch', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) }, // prompt bundle
    DrillAttempt: { findOne: () => ({ sort: async () => FAKE_ATTEMPT_IN_PROGRESS }) },
  });
  const ctrl = loadController();
  ctrl._setWorkersModule({ drillGraderQueue: { add: async () => {} } });
  const [req, res] = buildReqRes({
    user: { userId: FAKE_USER_ID },
    params: { id: FAKE_BUNDLE_ID },
    body: {
      drill_subtype: 'verify',  // mismatch: bundle is prompt
      submission: {
        bug_locations: [{ file: 'app.py', line: 5, explanation: 'Null pointer dereference here.' }],
      },
    },
  });
  await ctrl.submitDrill(req, res);
  assert.strictEqual(res._status, 400);
  assert.strictEqual(res._body.error, 'subtype_mismatch');
});

test('submitDrill: returns 404 no_active_attempt when no in-progress attempt exists', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: {
      findOne: () => ({ sort: () => ({ lean: async () => null }) }),
    },
  });
  // Need to support the chained findOne().sort() call
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: {
      findOne: () => ({
        sort: () => ({
          // simulate no active attempt
          then: undefined,  // not a promise itself
        }),
        // the actual await is on findOne()...sort() which should return null
      }),
    },
  });

  // Simpler: return null directly from the chained call
  const fakeDrillAttempt = {
    findOne: (query) => {
      // Return an object whose sort() method returns a thenable resolving to null
      return {
        sort: () => Promise.resolve(null),
      };
    },
  };
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: fakeDrillAttempt,
  });

  const ctrl = loadController();
  ctrl._setWorkersModule({ drillGraderQueue: { add: async () => {} } });
  const [req, res] = buildReqRes({
    user: { userId: FAKE_USER_ID },
    params: { id: FAKE_BUNDLE_ID },
    body: VALID_PROMPT_SUBMISSION,
  });
  await ctrl.submitDrill(req, res);
  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.error, 'no_active_attempt');
});

test('submitDrill: happy path returns 202 + enqueues grade job', async () => {
  const enqueuedJobs = [];
  const attemptDoc = {
    _id: FAKE_ATTEMPT_ID,
    user_id: FAKE_USER_ID,
    bundle_id: FAKE_BUNDLE_ID,
    status: 'in_progress',
    started_at: new Date(Date.now() - 3 * 60 * 1000),
    is_calibration: false,
    save: async function() { return this; },
  };

  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: {
      findOne: () => ({ sort: () => Promise.resolve(attemptDoc) }),
    },
  });
  const ctrl = loadController();
  ctrl._setWorkersModule({
    drillGraderQueue: {
      add: async (name, data) => {
        enqueuedJobs.push({ name, data });
        return { id: 'job-1' };
      },
    },
  });

  const [req, res] = buildReqRes({
    user: { userId: FAKE_USER_ID },
    params: { id: FAKE_BUNDLE_ID },
    body: VALID_PROMPT_SUBMISSION,
  });
  await ctrl.submitDrill(req, res);

  assert.strictEqual(res._status, 202);
  const body = res._body;
  assert.strictEqual(body.attempt_id, FAKE_ATTEMPT_ID);
  assert.strictEqual(body.status, 'submitted');
  assert.ok(body.poll_url.includes(FAKE_BUNDLE_ID));

  // Verify attempt was mutated
  assert.strictEqual(attemptDoc.status, 'submitted');
  assert.ok(attemptDoc.submitted_at instanceof Date);
  assert.ok(typeof attemptDoc.time_taken_seconds === 'number');

  // Verify job was enqueued
  assert.strictEqual(enqueuedJobs.length, 1);
  assert.strictEqual(enqueuedJobs[0].name, 'grade');
  assert.strictEqual(enqueuedJobs[0].data.drill_subtype, 'prompt');
  assert.ok(enqueuedJobs[0].data.drillAttemptId);
});

// ---------------------------------------------------------------------------
// ============================================================
// getResult tests
// ============================================================
// ---------------------------------------------------------------------------

test('getResult: returns 401 when req.user is null', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: null, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.getResult(req, res);
  assert.strictEqual(res._status, 401);
  assert.strictEqual(res._body.error, 'unauthorized');
});

test('getResult: returns 404 when no attempt found', async () => {
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: {
      findOne: () => ({ sort: () => ({ lean: async () => null }) }),
    },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.getResult(req, res);
  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.error, 'no_attempt_found');
});

test('getResult: returns 202 with status=submitted when attempt not yet graded', async () => {
  const submittedAttempt = {
    _id: FAKE_ATTEMPT_ID,
    status: 'submitted',
    bundle_id: FAKE_BUNDLE_ID,
  };
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: {
      findOne: () => ({ sort: () => ({ lean: async () => submittedAttempt }) }),
    },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.getResult(req, res);
  assert.strictEqual(res._status, 202);
  assert.strictEqual(res._body.status, 'submitted');
  assert.strictEqual(res._body.attempt_id, FAKE_ATTEMPT_ID);
});

test('getResult: returns 202 with status=in_progress when attempt still in progress', async () => {
  const inProgressAttempt = {
    _id: FAKE_ATTEMPT_ID,
    status: 'in_progress',
    bundle_id: FAKE_BUNDLE_ID,
  };
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: {
      findOne: () => ({ sort: () => ({ lean: async () => inProgressAttempt }) }),
    },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.getResult(req, res);
  assert.strictEqual(res._status, 202);
  assert.strictEqual(res._body.status, 'in_progress');
});

test('getResult: returns 200 with full grade view when attempt is graded', async () => {
  const gradedAttempt = {
    _id: FAKE_ATTEMPT_ID,
    status: 'graded',
    bundle_id: FAKE_BUNDLE_ID,
    grade: FAKE_GRADE,
  };
  stubCodingModels({
    ArtifactBundle: { findById: () => ({ lean: async () => FAKE_BUNDLE_PROMPT }) },
    DrillAttempt: {
      findOne: () => ({ sort: () => ({ lean: async () => gradedAttempt }) }),
    },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID }, params: { id: FAKE_BUNDLE_ID } });
  await ctrl.getResult(req, res);

  assert.strictEqual(res._status, 200);
  const body = res._body;
  assert.strictEqual(body.attempt_id, FAKE_ATTEMPT_ID);
  assert.strictEqual(body.status, 'graded');
  assert.strictEqual(body.overall_score, 82);
  assert.ok(Array.isArray(body.rubric_breakdown));
  assert.strictEqual(body.what_to_try_next, 'Try edge cases');
  assert.strictEqual(body.integrity_confidence, 'high');
  assert.ok(body.graded_at);
  assert.strictEqual(body.drill_subtype, 'prompt');
  assert.strictEqual(body.difficulty, 'easy');
  assert.strictEqual(body.role_track, 'swe');
});
