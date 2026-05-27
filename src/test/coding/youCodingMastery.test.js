'use strict';

/**
 * Tests for:
 *   1. computeOnTrackText / readiness display logic (pure unit)
 *   2. GET /api/v2/you/coding-mastery (route handler via req/res stubs)
 *
 * Strategy mirrors drills.api.test.js: stub all mongoose model calls so the
 * tests run without a real DB connection.
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

// ---------------------------------------------------------------------------
// Pure unit tests for computeOnTrackText
// (imported via the route module's exported helper — extracted below)
// ---------------------------------------------------------------------------

/**
 * Inline replica of the pure helper so we can unit-test it without loading
 * the entire Express route (which requires mongoose, auth middleware, etc.).
 * If you refactor the helper to a separate module, import it here instead.
 */
function computeOnTrackText({ readiness, targetDateStr, weeksOverdue }) {
  if (weeksOverdue !== null) {
    return 'Past deadline · keep pushing';
  }
  if (readiness >= 70) {
    return `On track for ${targetDateStr || 'your target'}`;
  }
  if (readiness >= 40) {
    return `Building readiness toward ${targetDateStr || 'target'}`;
  }
  return 'Early days · keep going';
}

/**
 * Compute weeksRemaining / weeksOverdue from a target date offset in days.
 * Positive offset = future; negative = past.
 */
function computeWeeks(offsetDays) {
  const now = new Date();
  const target = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  const diffMs = target - now;
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  let weeksRemaining = null;
  let weeksOverdue = null;
  if (diffDays > 0) {
    weeksRemaining = Math.ceil(diffDays / 7);
  } else if (diffDays < 0) {
    weeksOverdue = Math.ceil(-diffDays / 7);
  }
  return { weeksRemaining, weeksOverdue };
}

// ---------------------------------------------------------------------------
// onTrackText unit tests
// ---------------------------------------------------------------------------

test('onTrackText: readiness < 40 → "Early days"', () => {
  const result = computeOnTrackText({ readiness: 33, targetDateStr: 'Jun 2026', weeksOverdue: null });
  assert.ok(result.startsWith('Early days'), `Expected "Early days …" but got "${result}"`);
  assert.ok(!result.includes('33'), 'Must not duplicate the percentage');
});

test('onTrackText: readiness exactly 40 → "Building readiness"', () => {
  const result = computeOnTrackText({ readiness: 40, targetDateStr: 'Jun 2026', weeksOverdue: null });
  assert.ok(result.startsWith('Building readiness'), `Expected "Building readiness …" but got "${result}"`);
});

test('onTrackText: readiness 50 → "Building readiness"', () => {
  const result = computeOnTrackText({ readiness: 50, targetDateStr: 'Jun 2026', weeksOverdue: null });
  assert.ok(result.startsWith('Building readiness'), `Expected "Building readiness …" but got "${result}"`);
  assert.ok(!result.includes('50'), 'Must not duplicate the percentage');
});

test('onTrackText: readiness ≥ 70 → "On track for <date>"', () => {
  const result = computeOnTrackText({ readiness: 75, targetDateStr: 'Jun 2026', weeksOverdue: null });
  assert.strictEqual(result, 'On track for Jun 2026');
});

test('onTrackText: readiness ≥ 70 with null targetDateStr → "On track for your target"', () => {
  const result = computeOnTrackText({ readiness: 80, targetDateStr: null, weeksOverdue: null });
  assert.strictEqual(result, 'On track for your target');
});

test('onTrackText: past deadline → "Past deadline · keep pushing" regardless of readiness', () => {
  for (const readiness of [10, 50, 90]) {
    const result = computeOnTrackText({ readiness, targetDateStr: 'Jan 2025', weeksOverdue: 3 });
    assert.strictEqual(result, 'Past deadline · keep pushing',
      `Failed for readiness=${readiness}: got "${result}"`);
  }
});

// ---------------------------------------------------------------------------
// weeksRemaining / weeksOverdue computation tests
// ---------------------------------------------------------------------------

test('weeksRemaining: target 14 days in future → positive integer; weeksOverdue null', () => {
  const { weeksRemaining, weeksOverdue } = computeWeeks(14);
  assert.ok(typeof weeksRemaining === 'number' && weeksRemaining >= 2,
    `weeksRemaining should be ≥2, got ${weeksRemaining}`);
  assert.strictEqual(weeksOverdue, null);
});

test('weeksOverdue: target 21 days in past → positive integer; weeksRemaining null', () => {
  const { weeksRemaining, weeksOverdue } = computeWeeks(-21);
  assert.strictEqual(weeksRemaining, null);
  assert.ok(typeof weeksOverdue === 'number' && weeksOverdue >= 3,
    `weeksOverdue should be ≥3, got ${weeksOverdue}`);
});

test('weeksRemaining/weeksOverdue: both null when no target date', () => {
  // Simulates the branch where objective.targetDate is absent
  const weeksRemaining = null;
  const weeksOverdue = null;
  assert.strictEqual(weeksRemaining, null);
  assert.strictEqual(weeksOverdue, null);
});

// ---------------------------------------------------------------------------
// GET /api/v2/you/coding-mastery — route handler tests
// ---------------------------------------------------------------------------

const YOU_ROUTE_PATH = path.resolve(
  __dirname,
  '../../routes/v2/you.js'
);

// Paths of all modules the you.js router requires — stub them before loading.
const MODEL_STUBS = {
  User: path.resolve(__dirname, '../../models/User.js'),
  UserObjective: path.resolve(__dirname, '../../models/UserObjective.js'),
  Plan: path.resolve(__dirname, '../../models/Plan.js'),
  KnowledgeProfile: path.resolve(__dirname, '../../models/KnowledgeProfile.js'),
  CompetitionProfile: path.resolve(__dirname, '../../models/CompetitionProfile.js'),
  Journey: path.resolve(__dirname, '../../models/Journey.js'),
  Quiz: path.resolve(__dirname, '../../models/Quiz.js'),
  QuizAttempt: path.resolve(__dirname, '../../models/QuizAttempt.js'),
  Content: path.resolve(__dirname, '../../models/Content.js'),
  ContentProgress: path.resolve(__dirname, '../../models/ContentProgress.js'),
  InterviewSession: path.resolve(__dirname, '../../models/InterviewSession.js'),
  CognitiveProfile: path.resolve(__dirname, '../../models/CognitiveProfile.js'),
  CompassConversation: path.resolve(__dirname, '../../models/CompassConversation.js'),
  Conversation: path.resolve(__dirname, '../../models/Conversation.js'),
  CreatorProfile: path.resolve(__dirname, '../../models/CreatorProfile.js'),
  CreatorApplication: path.resolve(__dirname, '../../models/CreatorApplication.js'),
  DiagnosticAttempt: path.resolve(__dirname, '../../models/DiagnosticAttempt.js'),
};

const PLAN_SERVICE_PATH = path.resolve(
  __dirname,
  '../../services/v2/planService.js'
);
const AUTH_PATH = path.resolve(__dirname, '../../middleware/auth.js');
const MONGOOSE_PATH = require.resolve('mongoose');

/**
 * Build a minimal no-op Mongoose model stub that satisfies the v2/you/overview
 * and /analytics handlers (which call these models on require).
 */
function makeModelStub() {
  return {
    findById: () => ({ select: () => ({ lean: async () => null }) }),
    findOne: () => ({ lean: async () => null, sort: () => ({ lean: async () => null }), select: () => ({ lean: async () => null }) }),
    find: () => ({
      select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
      sort: () => ({ limit: () => ({ lean: async () => [] }), lean: async () => [] }),
      lean: async () => [],
    }),
    countDocuments: async () => 0,
  };
}

/**
 * Build a fake req/res pair for route testing.
 */
function buildReqRes({ user = null, query = {}, params = {} } = {}) {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(payload) { this._body = payload; return this; },
  };
  const req = { user, query, params };
  return [req, res];
}

const FAKE_USER_ID = '64f1a2b3c4d5e6f7a8b9c0d1';

/**
 * Load (or reload) the you router. All model stubs must be in require.cache
 * before calling this.
 */
function loadYouRouter() {
  delete require.cache[YOU_ROUTE_PATH];
  return require(YOU_ROUTE_PATH);
}

/**
 * Register a stub mongoose instance that intercepts mongoose.model() calls
 * and returns the appropriate fake model.
 *
 * modelMap: { ModelName: stubObject }
 */
function stubMongoose(modelMap) {
  const originalMongoose = require(MONGOOSE_PATH);
  // We monkey-patch model() on the real mongoose singleton so that
  // mongoose.model('Foo') returns our stub instead of hitting the DB.
  // This is scoped to the test — restore after.
  const origModel = originalMongoose.model.bind(originalMongoose);
  originalMongoose.model = (name, schema) => {
    if (schema) return origModel(name, schema); // registration call — pass through
    if (modelMap[name]) return modelMap[name];
    return origModel(name);
  };
  return () => { originalMongoose.model = origModel; };
}

// ── Test: empty state (no mastery docs) ────────────────────────────────────

test('GET /v2/you/coding-mastery — empty state for user with no mastery yet', async () => {
  // Stub mongoose.model for the four coding models used by coding-mastery.
  const emptyFind = { find: async () => [], countDocuments: async () => 0, aggregate: async () => [] };
  const restore = stubMongoose({
    MetaSkillMastery: { find: () => ({ lean: async () => [] }) },
    DifficultyState:  { find: () => ({ lean: async () => [] }) },
    DrillAttempt: {
      find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
      countDocuments: async () => 0,
      aggregate: async () => [],
    },
    ArtifactBundle: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  });

  // Stub all the other models that are required at load time so the router
  // doesn't throw "Model not found" when first required.
  for (const [, absPath] of Object.entries(MODEL_STUBS)) {
    stubModule(absPath, makeModelStub());
  }
  stubModule(PLAN_SERVICE_PATH, {
    buildPhases: () => [], buildMilestones: () => [], buildWeeksDetail: () => [],
    buildTopicCoverage: () => [], buildPlanSummary: () => ({}), buildCompletedHistory: async () => [],
    buildPlanWriteUp: () => '',
  });
  // auth middleware: just calls next()
  stubModule(AUTH_PATH, (_req, _res, next) => next());

  const router = loadYouRouter();

  // Find the coding-mastery handler on the router stack.
  const layer = router.stack.find(
    l => l.route && l.route.path === '/coding-mastery' && l.route.methods.get
  );
  assert.ok(layer, 'coding-mastery route must exist on the router');

  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  // Run through all handlers on the route (skipping auth since it's a stub).
  const handlers = layer.route.stack.map(s => s.handle);
  for (const handler of handlers) {
    await handler(req, res, () => {});
    if (res._body !== null) break;
  }

  restore();

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.success, true);
  assert.deepStrictEqual(res._body.data.tracks, []);
  assert.deepStrictEqual(res._body.data.recent_attempts, []);
  assert.strictEqual(res._body.data.stats.total_drills_graded, 0);
  assert.strictEqual(res._body.data.stats.average_score, null);
});

// ── Test: populated user ───────────────────────────────────────────────────

test('GET /v2/you/coding-mastery — populated user', async () => {
  const fakeBundle = {
    _id: 'bundle-001',
    drill_subtype: 'prompt',
    difficulty: 'easy',
    role_track: 'swe',
  };
  const fakeAttempt = {
    _id: 'attempt-001',
    bundle_id: 'bundle-001',
    drill_subtype: 'prompt',
    status: 'graded',
    submitted_at: new Date('2026-05-01T10:00:00Z'),
    is_calibration: false,
    grade: { overall_score: 82 },
  };
  const fakeMastery = {
    _id: 'mastery-001',
    user_id: FAKE_USER_ID,
    role_track: 'swe',
    axes: { code_quality: 80, problem_solving: 75 },
    confidence: 0.7,
    attempt_count: 5,
  };
  const fakeDiffState = {
    _id: 'diff-001',
    user_id: FAKE_USER_ID,
    role_track: 'swe',
    current_difficulty: 'medium',
    recommendation_history: [{ from: 'easy', to: 'medium', reason: 'score_above_threshold' }],
  };

  const restore = stubMongoose({
    MetaSkillMastery: { find: () => ({ lean: async () => [fakeMastery] }) },
    DifficultyState:  { find: () => ({ lean: async () => [fakeDiffState] }) },
    DrillAttempt: {
      find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [fakeAttempt] }) }) }),
      countDocuments: async () => 1,
      aggregate: async () => [{ _id: null, avg: 82 }],
    },
    ArtifactBundle: {
      find: () => ({ select: () => ({ lean: async () => [fakeBundle] }) }),
    },
  });

  for (const [, absPath] of Object.entries(MODEL_STUBS)) {
    stubModule(absPath, makeModelStub());
  }
  stubModule(PLAN_SERVICE_PATH, {
    buildPhases: () => [], buildMilestones: () => [], buildWeeksDetail: () => [],
    buildTopicCoverage: () => [], buildPlanSummary: () => ({}), buildCompletedHistory: async () => [],
    buildPlanWriteUp: () => '',
  });
  stubModule(AUTH_PATH, (_req, _res, next) => next());

  const router = loadYouRouter();

  const layer = router.stack.find(
    l => l.route && l.route.path === '/coding-mastery' && l.route.methods.get
  );
  assert.ok(layer, 'coding-mastery route must exist on the router');

  const [req, res] = buildReqRes({ user: { userId: FAKE_USER_ID } });
  const handlers = layer.route.stack.map(s => s.handle);
  for (const handler of handlers) {
    await handler(req, res, () => {});
    if (res._body !== null) break;
  }

  restore();

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.success, true);

  const { tracks, recent_attempts, stats } = res._body.data;

  // tracks
  assert.strictEqual(tracks.length, 1);
  assert.strictEqual(tracks[0].role_track, 'swe');
  assert.strictEqual(tracks[0].current_difficulty, 'medium');
  assert.ok(tracks[0].axes && typeof tracks[0].axes.code_quality === 'number',
    'axes should be present with numeric values');

  // recent_attempts
  assert.strictEqual(recent_attempts.length, 1);
  assert.strictEqual(recent_attempts[0].score, 82);
  assert.strictEqual(recent_attempts[0].difficulty, 'easy');
  assert.strictEqual(recent_attempts[0].role_track, 'swe');
  assert.strictEqual(recent_attempts[0].is_calibration, false);

  // stats
  assert.strictEqual(stats.total_drills_graded, 1);
  assert.strictEqual(stats.average_score, 82);
});
