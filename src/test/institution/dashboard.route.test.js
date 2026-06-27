'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

function stubLoadUser(institutionId, role) {
  institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId, role, status: 'active', tokenVersion: 0, scope: {} });
}

const dashboard = require('../../routes/institution/dashboard');

function tok(i, r) { return signInstitutionToken({ _id: 'u1', institutionId: i, role: r, tokenVersion: 0 }); }
function appAs(i, r) { stubLoadUser(i, r); const a = express(); a.use(express.json()); a.use('/api/institution', dashboard); return a; }

test('GET /dashboard returns the assembled data (any role); scope from token', async () => {
  let captured = null;
  dashboard._deps = { dashboardService: { build: async (scope) => { captured = scope; return {
    outcomes: { placementPercent: 50, highestCtc: 30, averageCtc: 21, medianCtc: 21, companiesVisited: 3, placedCount: 2, cohortSize: 4, statusCounts: {}, branchWise: [] },
    funnel: { invited: 10, registered: 8, diagnosticDone: 6, active: 5, placed: 2 },
    upcomingDrives: [{ _id: 'd1', name: 'Acme', status: 'open' }],
    attention: { configuredAssessments: 1, pendingRosters: 0, drivesThisWeek: 1 },
  }; } } };
  const res = await request(appAs('inst-A','viewer')).get('/api/institution/dashboard')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(captured.institutionId, 'inst-A');
  assert.strictEqual(res.body.data.funnel.invited, 10);
  assert.strictEqual(res.body.data.outcomes.placementPercent, 50);
  dashboard._deps = null;
});

const dashboardService = require('../../services/institution/dashboardService');
test('dashboardService.build assembles funnel + upcoming drives + attention', async () => {
  const NOW = new Date('2026-07-01T00:00:00Z');
  const data = await dashboardService.build({ institutionId: 'inst-A' }, {
    now: NOW,
    outcomeService: { institutionOutcomes: async () => ({ institution: { placedCount: 2, placementPercent: 50 }, cohorts: [{ cohortId: 'c1', label: 'CSE 2026' }] }) },
    InstitutionEnrollment: { countDocuments: async (q) => ({ invited: 10, registered: 8, diagnostic_done: 6, active: 5 }[q.status] ?? 0) },
    PlacementDrive: { find: () => ({ lean: async () => ([
      { _id: 'd1', name: 'Acme', driveDate: new Date('2026-07-03'), status: 'open', cohortId: 'c1' },        // upcoming, this week
      { _id: 'd2', name: 'Globex', driveDate: new Date('2026-06-20'), status: 'closed', cohortId: 'c1' },    // past
      { _id: 'd3', name: 'Initech', driveDate: new Date('2026-08-15'), status: 'upcoming', cohortId: 'c1' }, // upcoming, not this week
    ]) }) },
    Assessment: { countDocuments: async () => 1 },
    pendingRostersCount: async () => 0,
  });
  assert.strictEqual(data.funnel.invited, 10);
  assert.strictEqual(data.funnel.placed, 2);
  assert.deepStrictEqual(data.upcomingDrives.map((d) => d._id), ['d1', 'd3']); // future only, sorted asc; not d2
  assert.strictEqual(data.upcomingDrives[0].cohortLabel, 'CSE 2026');
  assert.strictEqual(data.attention.configuredAssessments, 1);
  assert.strictEqual(data.attention.drivesThisWeek, 1); // only d1 within 7 days
});
