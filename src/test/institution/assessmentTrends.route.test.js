'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

function stubLoadUser(role) {
  institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId: 'i1', role, status: 'active', tokenVersion: 0, scope: {} });
}
const assessments = require('../../routes/institution/assessments');
function tok(role) { return signInstitutionToken({ _id: 'u1', institutionId: 'i1', role, tokenVersion: 0 }); }
function appAs(role) {
  stubLoadUser(role);
  const a = express(); a.use(express.json()); a.use('/api/institution', assessments); return a;
}

// ── Task 2: Trends route tests ─────────────────────────────────────────────────

// Test 1: GET /cohorts/:cohortId/trends → 200 with trends data
test('GET /cohorts/:cohortId/trends → 200 with trends data', async () => {
  const fakeTrends = [
    { assessmentId: 'a1', title: 'Round 1', type: 'mcq', at: new Date('2026-01-01'), avgScore: 72, graded: 20, byCompetency: [] },
    { assessmentId: 'a2', title: 'Round 2', type: 'mcq', at: new Date('2026-02-01'), avgScore: 78, graded: 18, byCompetency: [] },
  ];

  assessments._deps = {
    InstitutionCohort: {
      findOne: async (filter) => {
        assert.strictEqual(String(filter.institutionId), 'i1');
        assert.strictEqual(String(filter._id), 'c1');
        return { _id: 'c1', institutionId: 'i1', label: 'Batch 2026' };
      },
    },
    trendsService: {
      buildTrends: async (cohortId, deps) => {
        assert.strictEqual(String(cohortId), 'c1');
        return fakeTrends;
      },
    },
    CohortRollup: { findOne: async () => null },
    Assessment: { findById: async () => null },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/c1/trends')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(Array.isArray(res.body.data), 'data should be an array');
  assert.strictEqual(res.body.data.length, 2);
  assert.strictEqual(res.body.data[0].title, 'Round 1');
  assert.strictEqual(res.body.data[1].avgScore, 78);
  assessments._deps = null;
});

// Test 2: GET /cohorts/:cohortId/trends → 404 when cohort not in institution
test('GET /cohorts/:cohortId/trends → 404 when cohort not in institution', async () => {
  assessments._deps = {
    InstitutionCohort: {
      findOne: async () => null, // not found / scoped out
    },
    trendsService: {
      buildTrends: async () => { throw new Error('Should not be called'); },
    },
  };

  const res = await request(appAs('tpo_head'))
    .get('/api/institution/cohorts/c-evil/trends')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.success, false);
  assessments._deps = null;
});

// Test 3: GET /cohorts/comparison?cohortIds=c1,c2 → 200 with comparison data
test('GET /cohorts/comparison?cohortIds=c1,c2 → 200 with comparison data', async () => {
  const fakeComparison = [
    { cohortId: 'c1', label: 'Batch A', assessmentsGraded: 3, avgScore: 74, byCompetency: [] },
    { cohortId: 'c2', label: 'Batch B', assessmentsGraded: 2, avgScore: 68, byCompetency: [] },
  ];

  assessments._deps = {
    trendsService: {
      buildComparison: async (institutionId, cohortIds, deps) => {
        assert.strictEqual(String(institutionId), 'i1');
        assert.deepStrictEqual(cohortIds, ['c1', 'c2']);
        return fakeComparison;
      },
    },
    InstitutionCohort: { find: async () => [] },
    CohortRollup: { find: async () => [] },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/comparison?cohortIds=c1,c2')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(Array.isArray(res.body.data), 'data should be an array');
  assert.strictEqual(res.body.data.length, 2);
  assert.strictEqual(res.body.data[0].label, 'Batch A');
  assert.strictEqual(res.body.data[1].avgScore, 68);
  assessments._deps = null;
});

// Test 4: GET /cohorts/comparison without cohortIds → 400
test('GET /cohorts/comparison without cohortIds → 400', async () => {
  assessments._deps = {
    trendsService: {
      buildComparison: async () => { throw new Error('Should not be called'); },
    },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/comparison')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.success, false);
  assert.ok(res.body.message, 'message should be present');
  assessments._deps = null;
});

// Test 5: Unauthenticated request to trends → 401
test('GET /cohorts/:cohortId/trends without auth → 401', async () => {
  // No Authorization header — institutionAuth should reject
  const a = express(); a.use(express.json()); a.use('/api/institution', assessments);

  const res = await request(a)
    .get('/api/institution/cohorts/c1/trends');

  assert.strictEqual(res.status, 401);
});
