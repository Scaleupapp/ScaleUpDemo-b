'use strict';
/**
 * Workstream A — placement first-login backend.
 *
 * Unit tests for the deps-injectable helpers behind
 *   POST /api/v2/me/placement-onboarding/complete
 *   GET  /api/v2/me/placement-onboarding   (season/cohort extras)
 *
 * All deps injected — no DB, no auth, no supertest.
 */
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');

const meRouter = require('../../routes/v2/me');
const { completePlacementOnboarding, buildPlacementOnboardingExtras } = meRouter._helpers;

// ── completePlacementOnboarding ───────────────────────────────────────────────

test('completePlacementOnboarding: NOT_PLACEMENT when the user has no active enrollment', async () => {
  let userUpdated = false;
  let markCalled = false;
  const deps = {
    InstitutionEnrollment: { findOne: async () => null }, // D2C user — no enrollment
    User: { updateOne: async () => { userUpdated = true; } },
    enrollmentProgressService: { markDiagnosticDone: async () => { markCalled = true; } },
  };
  const res = await completePlacementOnboarding('u1', deps);
  assert.deepStrictEqual(res, { ok: false, code: 'NOT_PLACEMENT' });
  assert.strictEqual(userUpdated, false, 'must not flip D2C user flags');
  assert.strictEqual(markCalled, false, 'must not advance enrollment for a non-placement user');
});

test('completePlacementOnboarding: flips flags + advances enrollment for a placement student', async () => {
  let captured = null;
  let markUserId = null;
  const deps = {
    InstitutionEnrollment: { findOne: async (q) => ({ _id: 'e1', userId: q.userId, status: 'registered' }) },
    User: { updateOne: async (filter, update) => { captured = { filter, update }; return { modifiedCount: 1 }; } },
    enrollmentProgressService: { markDiagnosticDone: async (uid) => { markUserId = uid; } },
  };
  const res = await completePlacementOnboarding('u2', deps);
  assert.deepStrictEqual(res, { ok: true });
  assert.deepStrictEqual(captured.filter, { _id: 'u2' });
  assert.deepStrictEqual(captured.update, { $set: { diagnosticComplete: true, v2NeedsOnboarding: false } });
  assert.strictEqual(markUserId, 'u2', 'enrollment advance called with the userId');
});

test('completePlacementOnboarding: enrollment status registered|diagnostic_done|active all pass the guard', async () => {
  for (const status of ['registered', 'diagnostic_done', 'active']) {
    const deps = {
      InstitutionEnrollment: { findOne: async () => ({ _id: 'e', status }) },
      User: { updateOne: async () => ({}) },
      enrollmentProgressService: { markDiagnosticDone: async () => {} },
    };
    const res = await completePlacementOnboarding('u', deps);
    assert.deepStrictEqual(res, { ok: true }, `status ${status} should be allowed`);
  }
});

test('completePlacementOnboarding: markDiagnosticDone failure is non-fatal (still ok)', async () => {
  let userUpdated = false;
  const deps = {
    InstitutionEnrollment: { findOne: async () => ({ _id: 'e1', status: 'active' }) },
    User: { updateOne: async () => { userUpdated = true; } },
    enrollmentProgressService: { markDiagnosticDone: async () => { throw new Error('funnel down'); } },
  };
  const res = await completePlacementOnboarding('u3', deps);
  assert.deepStrictEqual(res, { ok: true }, 'best-effort: a funnel error must not fail completion');
  assert.strictEqual(userUpdated, true, 'user flags are still flipped before the best-effort advance');
});

test('completePlacementOnboarding: idempotent — repeat calls stay ok', async () => {
  const deps = {
    InstitutionEnrollment: { findOne: async () => ({ _id: 'e1', status: 'diagnostic_done' }) },
    User: { updateOne: async () => ({ modifiedCount: 0 }) },
    enrollmentProgressService: { markDiagnosticDone: async () => ({ modifiedCount: 0 }) },
  };
  assert.deepStrictEqual(await completePlacementOnboarding('u4', deps), { ok: true });
  assert.deepStrictEqual(await completePlacementOnboarding('u4', deps), { ok: true });
});

// ── buildPlacementOnboardingExtras ────────────────────────────────────────────

test('buildPlacementOnboardingExtras: pulls season window + non-withdrawn cohort count', async () => {
  let capturedCountFilter = null;
  const enr = {
    cohortId: {
      _id: 'c1',
      placementSeason: { startDate: new Date('2026-08-01'), endDate: new Date('2026-12-15') },
    },
  };
  const deps = {
    InstitutionEnrollment: {
      countDocuments: async (filter) => { capturedCountFilter = filter; return 142; },
    },
  };
  const out = await buildPlacementOnboardingExtras(enr, deps);
  assert.strictEqual(out.seasonName, null, 'no dedicated season name field today → null');
  assert.strictEqual(out.seasonStartsAt.toISOString(), new Date('2026-08-01').toISOString());
  assert.strictEqual(out.seasonEndsAt.toISOString(), new Date('2026-12-15').toISOString());
  assert.strictEqual(out.cohortStudentCount, 142);
  assert.deepStrictEqual(capturedCountFilter, { cohortId: 'c1', status: { $ne: 'withdrawn' } });
});

test('buildPlacementOnboardingExtras: all-null when cohort/season absent (never throws)', async () => {
  const deps = { InstitutionEnrollment: { countDocuments: async () => 0 } };
  const out = await buildPlacementOnboardingExtras({ cohortId: null }, deps);
  assert.deepStrictEqual(out, { seasonName: null, seasonStartsAt: null, seasonEndsAt: null, cohortStudentCount: null });
});

test('buildPlacementOnboardingExtras: a count/DB error yields nulls, not a throw', async () => {
  const enr = { cohortId: { _id: 'c9', placementSeason: { startDate: new Date('2026-01-01') } } };
  const deps = { InstitutionEnrollment: { countDocuments: async () => { throw new Error('db down'); } } };
  const out = await buildPlacementOnboardingExtras(enr, deps);
  // Season fields resolved before the throw are kept; the count stays null.
  assert.strictEqual(out.seasonStartsAt.toISOString(), new Date('2026-01-01').toISOString());
  assert.strictEqual(out.cohortStudentCount, null);
});

test('buildPlacementOnboardingExtras: surfaces a season name if one ever exists on the sub-doc', async () => {
  const enr = { cohortId: { _id: 'c2', placementSeason: { name: 'Placements 2026', startDate: null, endDate: null } } };
  const deps = { InstitutionEnrollment: { countDocuments: async () => 5 } };
  const out = await buildPlacementOnboardingExtras(enr, deps);
  assert.strictEqual(out.seasonName, 'Placements 2026');
});
