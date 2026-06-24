'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  buildTrends,
  buildComparison,
} = require('../../services/institution/assessment/assessmentTrendsService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(s) {
  return s; // plain strings work fine as IDs in these pure-logic tests
}

function makeRollup(assessmentId, avgScore, graded, byCompetency, computedAt) {
  return {
    assessmentId,
    avgScore,
    counts: { graded },
    byCompetency: byCompetency || [],
    computedAt: computedAt || new Date('2026-01-01T00:00:00Z'),
  };
}

function makeAssessment(id, title, type, closedAt, closesAt) {
  return { _id: id, title, type, closedAt: closedAt || null, closesAt: closesAt || null };
}

// ---------------------------------------------------------------------------
// buildTrends tests
// ---------------------------------------------------------------------------

test('buildTrends returns items time-ordered ascending by at, with correct fields', async () => {
  const a1 = makeAssessment('ass1', 'Batch 1', 'mcq', new Date('2026-03-01'), null);
  const a2 = makeAssessment('ass2', 'Batch 2', 'interview', new Date('2026-01-15'), null);
  const a3 = makeAssessment('ass3', 'Batch 3', 'capstone', new Date('2026-06-10'), null);

  const rollups = [
    makeRollup('ass1', 75, 10, [{ name: 'Logic', avgScore: 70, n: 10 }]),
    makeRollup('ass2', 80, 5, []),
    makeRollup('ass3', 65, 8, [{ name: 'Comms', avgScore: 60, n: 8 }]),
  ];

  const deps = {
    CohortRollup: {
      find: async (q) => {
        assert.strictEqual(q.cohortId, 'cohort1');
        assert.deepStrictEqual(q.assessmentId, { $ne: null });
        return rollups;
      },
    },
    Assessment: {
      findById: async (id) => {
        if (id === 'ass1') return a1;
        if (id === 'ass2') return a2;
        if (id === 'ass3') return a3;
        return null;
      },
    },
  };

  const result = await buildTrends('cohort1', deps);

  assert.strictEqual(result.length, 3);

  // Should be sorted ascending by at — a2 (Jan 15), a1 (Mar 1), a3 (Jun 10)
  assert.strictEqual(result[0].assessmentId, 'ass2');
  assert.strictEqual(result[1].assessmentId, 'ass1');
  assert.strictEqual(result[2].assessmentId, 'ass3');

  // Spot-check fields on first item
  const first = result[0];
  assert.strictEqual(first.title, 'Batch 2');
  assert.strictEqual(first.type, 'interview');
  assert.deepStrictEqual(first.at, new Date('2026-01-15'));
  assert.strictEqual(first.avgScore, 80);
  assert.strictEqual(first.graded, 5);
  assert.deepStrictEqual(first.byCompetency, []);
});

test('buildTrends uses closedAt first, then closesAt, then computedAt for at', async () => {
  const computedAt = new Date('2026-05-01T00:00:00Z');
  const closesAt = new Date('2026-04-20T00:00:00Z');
  const closedAt = new Date('2026-04-18T00:00:00Z');

  const rollupA = makeRollup('aA', 70, 3, [], computedAt);
  const rollupB = makeRollup('aB', 70, 3, [], computedAt);
  const rollupC = makeRollup('aC', 70, 3, [], computedAt);

  const deps = {
    CohortRollup: {
      find: async () => [rollupA, rollupB, rollupC],
    },
    Assessment: {
      findById: async (id) => {
        if (id === 'aA') return makeAssessment('aA', 'T1', 'mcq', closedAt, closesAt);
        if (id === 'aB') return makeAssessment('aB', 'T2', 'mcq', null, closesAt);
        if (id === 'aC') return makeAssessment('aC', 'T3', 'mcq', null, null);
        return null;
      },
    },
  };

  const result = await buildTrends('cohortX', deps);

  assert.strictEqual(result.length, 3);
  const byId = Object.fromEntries(result.map((r) => [r.assessmentId, r]));

  // closedAt wins when present
  assert.deepStrictEqual(byId['aA'].at, closedAt);
  // closesAt used when closedAt is null
  assert.deepStrictEqual(byId['aB'].at, closesAt);
  // computedAt fallback when both are null
  assert.deepStrictEqual(byId['aC'].at, computedAt);
});

test('buildTrends skips rollups whose assessment is not found', async () => {
  const rollups = [
    makeRollup('present', 80, 4, []),
    makeRollup('gone', 60, 2, []),
  ];

  const deps = {
    CohortRollup: {
      find: async () => rollups,
    },
    Assessment: {
      findById: async (id) => {
        if (id === 'present') return makeAssessment('present', 'Kept', 'mcq', new Date('2026-03-01'), null);
        return null; // 'gone' not found
      },
    },
  };

  const result = await buildTrends('cohortZ', deps);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].assessmentId, 'present');
});

// ---------------------------------------------------------------------------
// buildComparison tests
// ---------------------------------------------------------------------------

test('buildComparison aggregates per cohort correctly', async () => {
  const cohort = { _id: 'c1', label: 'CS 2026', institutionId: 'inst1' };

  const rollups = [
    makeRollup('aX', 80, 5, [{ name: 'Logic', avgScore: 60, n: 5 }, { name: 'Comms', avgScore: 70, n: 5 }]),
    makeRollup('aY', 60, 3, [{ name: 'Logic', avgScore: 80, n: 3 }]),
  ];

  const deps = {
    InstitutionCohort: {
      find: async () => [cohort],
    },
    CohortRollup: {
      find: async (q) => {
        if (String(q.cohortId) === 'c1') return rollups;
        return [];
      },
    },
  };

  const result = await buildComparison('inst1', ['c1'], deps);

  assert.strictEqual(result.length, 1);
  const c = result[0];
  assert.strictEqual(c.cohortId, 'c1');
  assert.strictEqual(c.label, 'CS 2026');
  assert.strictEqual(c.assessmentsGraded, 2);

  // avgScore = Math.round((80 + 60) / 2) = 70
  assert.strictEqual(c.avgScore, 70);

  // byCompetency: Logic: (60*5 + 80*3)/(5+3) = (300+240)/8 = 67.5 → 68; Comms: 70
  const byComp = Object.fromEntries(c.byCompetency.map((x) => [x.name, x]));
  assert.strictEqual(byComp['Logic'].avgScore, Math.round((60 * 5 + 80 * 3) / (5 + 3)));
  assert.strictEqual(byComp['Logic'].n, 8);
  assert.strictEqual(byComp['Comms'].avgScore, 70);
  assert.strictEqual(byComp['Comms'].n, 5);

  // Sorted by name: Comms, Logic
  assert.strictEqual(c.byCompetency[0].name, 'Comms');
  assert.strictEqual(c.byCompetency[1].name, 'Logic');
});

test('buildComparison excludes cohortIds not in the institution', async () => {
  // InstitutionCohort.find returns only c1 (c2 is excluded as cross-institution)
  const cohortC1 = { _id: 'c1', label: 'Own Cohort', institutionId: 'inst1' };

  const deps = {
    InstitutionCohort: {
      find: async (q) => {
        // Simulate DB filtering: only return cohorts that are $in the given ids AND belong to inst
        const ids = q._id.$in.map(String);
        if (ids.includes('c1') && String(q.institutionId) === 'inst1') return [cohortC1];
        return [];
      },
    },
    CohortRollup: {
      find: async () => [makeRollup('a1', 70, 2, [])],
    },
  };

  const result = await buildComparison('inst1', ['c1', 'c2'], deps);

  // c2 should be silently excluded
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].cohortId, 'c1');
});

test('buildComparison caps at 10 cohorts', async () => {
  // Pass 12 cohort IDs; only 10 should be queried
  const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const cohorts = ids.slice(0, 10).map((id) => ({ _id: id, label: `Cohort ${id}`, institutionId: 'inst1' }));

  let queriedIds = null;
  const deps = {
    InstitutionCohort: {
      find: async (q) => {
        queriedIds = q._id.$in;
        return cohorts;
      },
    },
    CohortRollup: {
      find: async () => [],
    },
  };

  const result = await buildComparison('inst1', ids, deps);

  // Only 10 IDs should have been passed to InstitutionCohort.find
  assert.strictEqual(queriedIds.length, 10);
  assert.strictEqual(result.length, 10);
});

test('buildComparison returns null avgScore when no rollups', async () => {
  const cohort = { _id: 'cEmpty', label: 'Empty Cohort', institutionId: 'inst1' };

  const deps = {
    InstitutionCohort: {
      find: async () => [cohort],
    },
    CohortRollup: {
      find: async () => [],
    },
  };

  const result = await buildComparison('inst1', ['cEmpty'], deps);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].avgScore, null);
  assert.strictEqual(result[0].assessmentsGraded, 0);
  assert.deepStrictEqual(result[0].byCompetency, []);
});
