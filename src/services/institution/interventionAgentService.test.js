'use strict';

const { test } = require('node:test');
const assert = require('assert');

const {
  buildCohortBrief,
  runWeekly,
  _helpers: { computeNotStartedCluster, computeWeakCompetencyCluster, computeInactiveCluster },
} = require('./interventionAgentService');

// ── Fakes ────────────────────────────────────────────────────────────────

function makeFinder(items) {
  // Ignores the query object (tests pre-filter the fixture themselves) —
  // matches the repo convention of DI fakes with zero real query semantics.
  return { find: async () => items, findOne: async () => items[0] || null };
}

const INST = 'inst1';
const COHORT = 'cohort1';
const NOW = new Date('2026-07-12T00:00:00.000Z');

function daysAgo(n, from = NOW) {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000);
}

function baseDeps(overrides = {}) {
  return {
    Assessment: makeFinder([]),
    AssessmentSession: makeFinder([]),
    InstitutionEnrollment: makeFinder([]),
    CohortRollup: makeFinder([]),
    InstitutionCohort: { findById: async () => ({ label: 'Cohort One' }) },
    isAgentEnabled: () => true,
    now: () => NOW,
    ...overrides,
  };
}

// ── not_started ──────────────────────────────────────────────────────────

test('not_started: enrolled students with no session against a released assessment are flagged', async () => {
  const deps = baseDeps({
    Assessment: makeFinder([{ _id: 'a1', title: 'Aptitude MCQ', status: 'released' }]),
    InstitutionEnrollment: makeFinder([
      { userId: 'u1', status: 'active', createdAt: daysAgo(30) },
      { userId: 'u2', status: 'active', createdAt: daysAgo(30) },
    ]),
    AssessmentSession: makeFinder([{ userId: 'u1', assessmentId: 'a1' }]),
  });
  const cluster = await computeNotStartedCluster({ institutionId: INST, cohortId: COHORT }, deps);
  assert.ok(cluster);
  assert.deepStrictEqual(cluster.studentIds, ['u2']);
  assert.strictEqual(cluster.evidence.releasedAssessmentCount, 1);
  assert.strictEqual(cluster.proposedAction.kind, 'notify_students');
  assert.ok(cluster.proposedAction.payload.message.length > 0);
});

test('not_started: only draft assessments (none released) -> null, draft never counted as assigned', async () => {
  const deps = baseDeps({
    // A REAL status filter this time — unlike makeFinder, so the test actually
    // exercises the service's `status: 'released'` query, not just the fixture.
    Assessment: { find: async (query) => [{ _id: 'a1', title: 'Draft MCQ', status: 'draft' }].filter((a) => a.status === (query && query.status)) },
    InstitutionEnrollment: makeFinder([{ userId: 'u1', status: 'active', createdAt: daysAgo(30) }]),
  });
  const cluster = await computeNotStartedCluster({ institutionId: INST, cohortId: COHORT }, deps);
  assert.strictEqual(cluster, null);
});

test('not_started: everyone already started -> null', async () => {
  const deps = baseDeps({
    Assessment: makeFinder([{ _id: 'a1', title: 'Aptitude MCQ', status: 'released' }]),
    InstitutionEnrollment: makeFinder([{ userId: 'u1', status: 'active', createdAt: daysAgo(30) }]),
    AssessmentSession: makeFinder([{ userId: 'u1', assessmentId: 'a1' }]),
  });
  const cluster = await computeNotStartedCluster({ institutionId: INST, cohortId: COHORT }, deps);
  assert.strictEqual(cluster, null);
});

// ── weak_competency ──────────────────────────────────────────────────────

function gradedSession(userId, engineType, raw) {
  return { userId, status: 'graded', engine: { type: engineType }, result: { score: 50, raw } };
}

test('weak_competency: student below threshold on the cohort weakest competency is flagged', async () => {
  const deps = baseDeps({
    CohortRollup: makeFinder([{ byCompetency: [{ name: 'DSA', avgScore: 55, n: 5 }, { name: 'Communication', avgScore: 30, n: 5 }] }]),
    AssessmentSession: makeFinder([
      gradedSession('u1', 'mcq', { competencyBreakdown: [{ competency: 'Communication', percentage: 25 }] }),
      gradedSession('u2', 'mcq', { competencyBreakdown: [{ competency: 'Communication', percentage: 80 }] }),
    ]),
  });
  const cluster = await computeWeakCompetencyCluster({ institutionId: INST, cohortId: COHORT }, deps);
  assert.ok(cluster);
  assert.deepStrictEqual(cluster.studentIds, ['u1']);
  assert.strictEqual(cluster.evidence.competencyName, 'Communication');
  assert.strictEqual(cluster.evidence.threshold, 40);
});

test('weak_competency: boundary — score exactly at threshold (40) is NOT flagged', async () => {
  const deps = baseDeps({
    CohortRollup: makeFinder([{ byCompetency: [{ name: 'Communication', avgScore: 45, n: 3 }] }]),
    AssessmentSession: makeFinder([
      gradedSession('u1', 'mcq', { competencyBreakdown: [{ competency: 'Communication', percentage: 40 }] }),
      gradedSession('u2', 'mcq', { competencyBreakdown: [{ competency: 'Communication', percentage: 39 }] }),
    ]),
  });
  const cluster = await computeWeakCompetencyCluster({ institutionId: INST, cohortId: COHORT }, deps);
  assert.ok(cluster);
  assert.deepStrictEqual(cluster.studentIds, ['u2']);
});

test('weak_competency: no cohort-wide rollup (empty byCompetency) -> null', async () => {
  const deps = baseDeps({ CohortRollup: makeFinder([]) });
  const cluster = await computeWeakCompetencyCluster({ institutionId: INST, cohortId: COHORT }, deps);
  assert.strictEqual(cluster, null);
});

// ── inactive ─────────────────────────────────────────────────────────────

test('inactive: boundary — enrolled exactly 14 days ago with zero sessions IS flagged', async () => {
  const deps = baseDeps({
    InstitutionEnrollment: makeFinder([{ userId: 'u1', status: 'active', createdAt: daysAgo(14) }]),
    AssessmentSession: makeFinder([]),
  });
  const cluster = await computeInactiveCluster({ institutionId: INST, cohortId: COHORT }, deps, NOW);
  assert.ok(cluster);
  assert.deepStrictEqual(cluster.studentIds, ['u1']);
  assert.strictEqual(cluster.evidence.windowDays, 14);
});

test('inactive: boundary — enrolled 13 days ago is NOT flagged yet', async () => {
  const deps = baseDeps({
    InstitutionEnrollment: makeFinder([{ userId: 'u1', status: 'active', createdAt: daysAgo(13) }]),
    AssessmentSession: makeFinder([]),
  });
  const cluster = await computeInactiveCluster({ institutionId: INST, cohortId: COHORT }, deps, NOW);
  assert.strictEqual(cluster, null);
});

test('inactive: enrolled 30 days ago but has a session (ever started) -> not flagged', async () => {
  const deps = baseDeps({
    InstitutionEnrollment: makeFinder([{ userId: 'u1', status: 'active', createdAt: daysAgo(30) }]),
    AssessmentSession: makeFinder([{ userId: 'u1' }]),
  });
  const cluster = await computeInactiveCluster({ institutionId: INST, cohortId: COHORT }, deps, NOW);
  assert.strictEqual(cluster, null);
});

// ── buildCohortBrief ─────────────────────────────────────────────────────

test('buildCohortBrief: null when no cluster fires', async () => {
  const deps = baseDeps();
  const brief = await buildCohortBrief({ institutionId: INST, cohortId: COHORT }, deps);
  assert.strictEqual(brief, null);
});

test('buildCohortBrief: non-null combines firing clusters + top-level proposedActions', async () => {
  const deps = baseDeps({
    InstitutionEnrollment: makeFinder([{ userId: 'u1', status: 'active', createdAt: daysAgo(30) }]),
    AssessmentSession: makeFinder([]),
  });
  const brief = await buildCohortBrief({ institutionId: INST, cohortId: COHORT }, deps);
  assert.ok(brief);
  assert.strictEqual(brief.clusters.length, 1);
  assert.strictEqual(brief.clusters[0].key, 'inactive');
  assert.strictEqual(brief.proposedActions.length, 1);
  assert.strictEqual(brief.proposedActions[0].clusterKey, 'inactive');
});

// ── runWeekly ────────────────────────────────────────────────────────────

test('runWeekly: flag off -> zero briefs, zero DB reads', async () => {
  let listCalled = false;
  const deps = baseDeps({
    isAgentEnabled: () => false,
    listCandidateCohorts: async () => { listCalled = true; return []; },
    record: async () => { throw new Error('record should not be called'); },
  });
  const result = await runWeekly(deps);
  assert.deepStrictEqual(result, { briefs: 0 });
  assert.strictEqual(listCalled, false);
});

test('runWeekly: one row per qualifying cohort', async () => {
  const recorded = [];
  const deps = baseDeps({
    listCandidateCohorts: async () => ([
      { institutionId: INST, cohortId: 'cohort-quiet' }, // inactive cluster fires
      { institutionId: INST, cohortId: 'cohort-clean' }, // nothing fires
    ]),
    InstitutionEnrollment: {
      find: async ({ cohortId } = {}) => {
        if (cohortId === 'cohort-quiet') return [{ userId: 'u1', status: 'active', createdAt: daysAgo(30) }];
        return [];
      },
    },
    AssessmentSession: makeFinder([]),
    Assessment: makeFinder([]),
    CohortRollup: makeFinder([]),
    record: async (payload) => { recorded.push(payload); return { _id: `dec-${recorded.length}` }; },
  });

  // computeNotStartedCluster/inactive read `cohortId` off the query object we
  // pass — reflect that through the fake above by threading cohortId along.
  const result = await runWeekly(deps);

  assert.strictEqual(result.briefs, 1);
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].agentId, 'intervention');
  assert.strictEqual(recorded[0].decisionType, 'brief');
  assert.strictEqual(recorded[0].cohortId, 'cohort-quiet');
  assert.strictEqual(recorded[0].action.kind, 'cohort_intervention_brief');
  assert.strictEqual(recorded[0].action.cohortLabel, 'Cohort One');
  assert.ok(Array.isArray(recorded[0].action.clusters) && recorded[0].action.clusters.length === 1);
  assert.strictEqual(recorded[0].promptVersion, 'intervention-v1');
});

test('runWeekly: per-cohort failure isolation — one cohort throws, the other still records', async () => {
  const recorded = [];
  const deps = baseDeps({
    listCandidateCohorts: async () => ([
      { institutionId: INST, cohortId: 'cohort-bad' },
      { institutionId: INST, cohortId: 'cohort-good' },
    ]),
    InstitutionEnrollment: {
      find: async ({ cohortId } = {}) => {
        if (cohortId === 'cohort-bad') throw new Error('DB blew up for this cohort');
        return [{ userId: 'u1', status: 'active', createdAt: daysAgo(30) }];
      },
    },
    AssessmentSession: makeFinder([]),
    Assessment: makeFinder([]),
    CohortRollup: makeFinder([]),
    record: async (payload) => { recorded.push(payload); return { _id: `dec-${recorded.length}` }; },
  });

  const result = await runWeekly(deps);
  assert.strictEqual(result.briefs, 1);
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].cohortId, 'cohort-good');
});
