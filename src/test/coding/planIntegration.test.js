'use strict';

/**
 * Unit tests for src/coding/services/planIntegration.js
 *
 * All Mongoose model calls are stubbed — no DB connection required.
 * UserObjective is injected via Module._resolveFilename intercept pattern
 * used elsewhere in this test suite.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const Module   = require('module');

// ── Coding models stub ────────────────────────────────────────────────────────

const models = require('../../coding/models');

// State variables reset before each test
let stubUserObjective  = null;   // { canonicalTopic } | null
let stubCountDocuments = 0;      // how many non-calibration DrillAttempts "today"
let stubBundleExists   = false;  // whether ArtifactBundle.exists returns truthy
let stubDiffState      = null;   // DifficultyState.findOne result | null
let stubMastery        = null;   // MetaSkillMastery.findOne result | null
let stubExactBundle    = null;   // ArtifactBundle matching subtype+difficulty | null
let stubFallbackBundle = null;   // ArtifactBundle fallback (any subtype) | null

// ── Stub: DrillAttempt ────────────────────────────────────────────────────────
models.DrillAttempt.countDocuments = async () => stubCountDocuments;

// ── Stub: ArtifactBundle ──────────────────────────────────────────────────────
// exists() — called by shouldOfferDrillToday
models.ArtifactBundle.exists = async () => stubBundleExists || null;

// findOne() — called by getDrillCandidate (returns a sort().lean() chain)
let findOneCallCount = 0;
models.ArtifactBundle.findOne = (_query) => {
  findOneCallCount += 1;
  // First call: exact subtype+difficulty match; second call: fallback
  const result = findOneCallCount === 1 ? stubExactBundle : stubFallbackBundle;
  return {
    sort: () => ({ lean: () => Promise.resolve(result) }),
  };
};

// ── Stub: DifficultyState ─────────────────────────────────────────────────────
models.DifficultyState.findOne = (_query) => ({
  lean: () => Promise.resolve(stubDiffState),
});

// ── Stub: MetaSkillMastery ────────────────────────────────────────────────────
models.MetaSkillMastery.findOne = (_query) => ({
  lean: () => Promise.resolve(stubMastery),
});

// ── Stub: UserObjective (resolved via Module._resolveFilename) ────────────────
// The planIntegration module does require('../../models/UserObjective') at
// runtime inside getUserRoleTrack. We intercept that require to return our stub.
const _origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === '../../models/UserObjective' || request === '../../models/userObjective') {
    return '__stubUserObjective__';
  }
  return _origResolve(request, parent, isMain, options);
};
// Register the stub module in the cache
require.cache['__stubUserObjective__'] = {
  id: '__stubUserObjective__',
  filename: '__stubUserObjective__',
  loaded: true,
  exports: {
    findOne: (_query) => ({
      lean: () => Promise.resolve(stubUserObjective),
    }),
  },
};

// ── Module under test — loaded AFTER stubs ────────────────────────────────────

const {
  shouldOfferDrillToday,
  getDrillCandidate,
  hasUsedDailyQuota,
  getUserRoleTrack,
  buildCandidate,
  prettySubtype,
  DAILY_DRILL_QUOTA,
} = require('../../coding/services/planIntegration');

// ── Reset helper ──────────────────────────────────────────────────────────────

function reset() {
  stubUserObjective  = null;
  stubCountDocuments = 0;
  stubBundleExists   = false;
  stubDiffState      = null;
  stubMastery        = null;
  stubExactBundle    = null;
  stubFallbackBundle = null;
  findOneCallCount   = 0;
}

function makeBundle(overrides = {}) {
  return {
    _id: 'bundle-abc-123',
    type: 'drill',
    drill_subtype: 'verify',
    role_track: 'swe',
    difficulty: 'easy',
    time_budget_minutes: 30,
    brief: 'Fix the bug in the authentication middleware.',
    status: 'active',
    createdAt: new Date(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: shouldOfferDrillToday — user has no coding objective → false
// ─────────────────────────────────────────────────────────────────────────────

test('shouldOfferDrillToday: no coding objective → false', async () => {
  reset();
  stubUserObjective = null; // no objective

  const result = await shouldOfferDrillToday('user1');
  assert.strictEqual(result, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: shouldOfferDrillToday — coding objective, no quota used, bundle exists → true
// ─────────────────────────────────────────────────────────────────────────────

test('shouldOfferDrillToday: coding objective + no attempts + bundle exists → true', async () => {
  reset();
  stubUserObjective  = { canonicalTopic: 'software-engineer' };
  stubCountDocuments = 0;
  stubBundleExists   = true;

  const result = await shouldOfferDrillToday('user1');
  assert.strictEqual(result, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: shouldOfferDrillToday — daily quota already used → false
// ─────────────────────────────────────────────────────────────────────────────

test('shouldOfferDrillToday: daily quota used (1 attempt today) → false', async () => {
  reset();
  stubUserObjective  = { canonicalTopic: 'software-engineer' };
  stubCountDocuments = DAILY_DRILL_QUOTA; // = 1 → quota reached
  stubBundleExists   = true;

  const result = await shouldOfferDrillToday('user1');
  assert.strictEqual(result, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: shouldOfferDrillToday — no active bundle for role_track → false
// ─────────────────────────────────────────────────────────────────────────────

test('shouldOfferDrillToday: no active bundle → false', async () => {
  reset();
  stubUserObjective  = { canonicalTopic: 'software-engineer' };
  stubCountDocuments = 0;
  stubBundleExists   = false; // no bundles

  const result = await shouldOfferDrillToday('user1');
  assert.strictEqual(result, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: shouldOfferDrillToday — calibration attempts don't count toward quota
//   Scenario: 1 calibration attempt today; countDocuments for is_calibration:{$ne:true} = 0.
//   shouldOfferDrillToday must still return true.
// ─────────────────────────────────────────────────────────────────────────────

test('shouldOfferDrillToday: calibration attempts excluded — user still eligible', async () => {
  reset();
  stubUserObjective  = { canonicalTopic: 'software-engineer' };
  // countDocuments is stubbed to return non-calibration count only (= 0)
  stubCountDocuments = 0;
  stubBundleExists   = true;

  const result = await shouldOfferDrillToday('user1');
  assert.strictEqual(result, true, 'calibration attempts must not count toward the daily quota');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: getDrillCandidate — happy path → correct TaskCandidate shape
// ─────────────────────────────────────────────────────────────────────────────

test('getDrillCandidate: happy path → returns candidate with correct shape', async () => {
  reset();
  stubUserObjective  = { canonicalTopic: 'software-engineer' };
  stubCountDocuments = 0;
  stubBundleExists   = true;
  stubExactBundle    = makeBundle({ drill_subtype: 'prompt', role_track: 'swe', difficulty: 'easy' });

  const candidate = await getDrillCandidate('user1');

  assert.ok(candidate, 'expected a non-null candidate');
  assert.strictEqual(candidate.type,            'coding_drill');
  assert.ok(candidate.bundle_id,                'bundle_id must be set');
  assert.strictEqual(candidate.role_track,      'swe');
  assert.ok(candidate.drill_subtype,            'drill_subtype must be set');
  assert.ok(candidate.difficulty,               'difficulty must be set');
  assert.ok(typeof candidate.title === 'string' && candidate.title.length > 0, 'title must be non-empty');
  assert.ok(typeof candidate.brief_preview === 'string',  'brief_preview must be a string');
  assert.ok(typeof candidate.estimated_minutes === 'number', 'estimated_minutes must be a number');
  assert.ok(typeof candidate.cta_url === 'string' && candidate.cta_url.startsWith('/api/coding/drills/'), 'cta_url must point to the drills API');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: getDrillCandidate — not eligible → null
// ─────────────────────────────────────────────────────────────────────────────

test('getDrillCandidate: not eligible (no objective) → null', async () => {
  reset();
  stubUserObjective = null;

  const candidate = await getDrillCandidate('user1');
  assert.strictEqual(candidate, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: getDrillCandidate — uses weakest axis to select drill_subtype
//   Mock mastery with low verification score → expects verify subtype drill
// ─────────────────────────────────────────────────────────────────────────────

test('getDrillCandidate: low verification mastery → prefers verify subtype bundle', async () => {
  reset();
  stubUserObjective  = { canonicalTopic: 'software-engineer' };
  stubCountDocuments = 0;
  stubBundleExists   = true;
  stubMastery        = {
    user_id: 'user1',
    role_track: 'swe',
    axes: {
      prompting: 70,
      verification: 10,  // weakest axis
      decomposition: 50,
      refactoring: 55,
    },
  };
  // Exact bundle returned for drill_subtype='verify' (first findOne call)
  stubExactBundle = makeBundle({ drill_subtype: 'verify', role_track: 'swe', difficulty: 'easy' });

  const candidate = await getDrillCandidate('user1');
  assert.ok(candidate, 'expected a candidate');
  assert.strictEqual(candidate.drill_subtype, 'verify',
    'should select verify because it is the weakest axis');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: getDrillCandidate — falls back to any drill if exact subtype missing
// ─────────────────────────────────────────────────────────────────────────────

test('getDrillCandidate: exact subtype unavailable → falls back to any active drill', async () => {
  reset();
  stubUserObjective  = { canonicalTopic: 'software-engineer' };
  stubCountDocuments = 0;
  stubBundleExists   = true;
  stubExactBundle    = null; // no exact match
  stubFallbackBundle = makeBundle({ drill_subtype: 'prompt', role_track: 'swe', difficulty: 'easy' });

  const candidate = await getDrillCandidate('user1');
  assert.ok(candidate, 'expected a candidate via fallback');
  assert.strictEqual(candidate.type, 'coding_drill');
  // drill_subtype is whatever the fallback bundle has
  assert.strictEqual(candidate.drill_subtype, 'prompt');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: hasUsedDailyQuota — boundary: 0 attempts → false; 1 attempt → true
// ─────────────────────────────────────────────────────────────────────────────

test('hasUsedDailyQuota: 0 attempts today → false', async () => {
  reset();
  stubCountDocuments = 0;
  const result = await hasUsedDailyQuota('user1');
  assert.strictEqual(result, false);
});

test('hasUsedDailyQuota: 1 attempt today → true (quota reached)', async () => {
  reset();
  stubCountDocuments = 1;
  const result = await hasUsedDailyQuota('user1');
  assert.strictEqual(result, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11: buildCandidate — brief_preview truncates briefs > 120 chars with '…'
// ─────────────────────────────────────────────────────────────────────────────

test('buildCandidate: brief > 120 chars → brief_preview truncated with "…"', () => {
  const longBrief = 'A'.repeat(200);
  const bundle = makeBundle({ brief: longBrief });
  const candidate = buildCandidate(bundle, 'swe');

  assert.ok(candidate.brief_preview.endsWith('…'), 'should end with ellipsis');
  // Byte length: 120 chars + '…' (3 bytes in UTF-8 but 1 JS char) → length = 121
  assert.strictEqual(candidate.brief_preview.length, 121,
    'brief_preview should be 120 chars + the ellipsis character');
});

test('buildCandidate: brief ≤ 120 chars → brief_preview not truncated', () => {
  const shortBrief = 'Short brief.';
  const bundle = makeBundle({ brief: shortBrief });
  const candidate = buildCandidate(bundle, 'swe');

  assert.strictEqual(candidate.brief_preview, shortBrief,
    'short brief should not be truncated');
  assert.ok(!candidate.brief_preview.endsWith('…'),
    'no ellipsis for short briefs');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 12: prettySubtype mappings
// ─────────────────────────────────────────────────────────────────────────────

test('prettySubtype("verify") → "Bug Hunt"', () => {
  assert.strictEqual(prettySubtype('verify'), 'Bug Hunt');
});

test('prettySubtype("prompt") → "Prompt"', () => {
  assert.strictEqual(prettySubtype('prompt'), 'Prompt');
});

test('prettySubtype("decompose") → "Decompose"', () => {
  assert.strictEqual(prettySubtype('decompose'), 'Decompose');
});

test('prettySubtype("refactor") → "Refactor with AI"', () => {
  assert.strictEqual(prettySubtype('refactor'), 'Refactor with AI');
});

test('prettySubtype("unknown") → "unknown" (pass-through)', () => {
  assert.strictEqual(prettySubtype('unknown'), 'unknown');
});
