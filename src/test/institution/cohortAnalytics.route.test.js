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

const analytics = require('../../routes/institution/analytics');
function tok(role) { return signInstitutionToken({ _id: 'u1', institutionId: 'i1', role, tokenVersion: 0 }); }
function appAs(role) {
  stubLoadUser(role);
  const a = express(); a.use(express.json()); a.use('/api/institution', analytics); return a;
}

// Test 1: GET /cohorts/:cohortId/analytics → 200 with competencies and atRisk
test('GET /cohorts/:cohortId/analytics → 200 with competencies and atRisk', async () => {
  const fakeRollup = {
    _id: 'r1',
    institutionId: 'i1',
    cohortId: 'c1',
    assessmentId: null,
    byCompetency: [
      { name: 'DSA', avgScore: 72, n: 20 },
      { name: 'Communication', avgScore: 55, n: 18 },
      { name: 'System Design', avgScore: 80, n: 15 },
    ],
  };

  analytics._deps = {
    CohortRollup: {
      findOne: async (filter) => {
        assert.strictEqual(String(filter.institutionId), 'i1');
        assert.strictEqual(String(filter.cohortId), 'c1');
        return fakeRollup;
      },
    },
    AssessmentSession: {
      find: async () => [],
    },
    InstitutionEnrollment: {
      find: async () => [],
    },
    User: {
      find: async () => [],
    },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/c1/analytics')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(Array.isArray(res.body.data.competencies), 'competencies should be an array');
  assert.ok(Array.isArray(res.body.data.atRisk), 'atRisk should be an array');
  assert.strictEqual(res.body.data.competencies.length, 3);
  analytics._deps = null;
});

// Test 2: competencies sorted weakest-first (ascending avgScore)
test('competencies sorted weakest-first', async () => {
  const fakeRollup = {
    byCompetency: [
      { name: 'DSA', avgScore: 72, n: 20 },
      { name: 'Communication', avgScore: 55, n: 18 },
      { name: 'System Design', avgScore: 80, n: 15 },
    ],
  };

  analytics._deps = {
    CohortRollup: { findOne: async () => fakeRollup },
    AssessmentSession: { find: async () => [] },
    InstitutionEnrollment: { find: async () => [] },
    User: { find: async () => [] },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/c1/analytics')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  const comps = res.body.data.competencies;
  assert.strictEqual(comps[0].name, 'Communication');
  assert.strictEqual(comps[0].avgScore, 55);
  assert.strictEqual(comps[1].name, 'DSA');
  assert.strictEqual(comps[2].name, 'System Design');
  analytics._deps = null;
});

// Test 3: atRisk — student with latest graded score < 40 appears with reason 'low_score'
test('atRisk: student with score < 40 gets reason low_score', async () => {
  const sessions = [
    {
      userId: 'user-low',
      cohortId: 'c1',
      status: 'graded',
      gradedAt: new Date('2026-01-10'),
      result: { score: 32 },
    },
    {
      userId: 'user-ok',
      cohortId: 'c1',
      status: 'graded',
      gradedAt: new Date('2026-01-10'),
      result: { score: 75 },
    },
  ];

  const enrollments = [
    { userId: 'user-low', rollNumber: 'R001', status: 'active' },
    { userId: 'user-ok', rollNumber: 'R002', status: 'active' },
  ];

  const users = [
    { _id: 'user-low', firstName: 'John', lastName: 'Doe' },
    { _id: 'user-ok', firstName: 'Jane', lastName: 'Smith' },
  ];

  analytics._deps = {
    CohortRollup: { findOne: async () => ({ byCompetency: [] }) },
    AssessmentSession: { find: async () => sessions },
    InstitutionEnrollment: { find: async () => enrollments },
    User: { find: async () => users },
  };

  const res = await request(appAs('tpo_head'))
    .get('/api/institution/cohorts/c1/analytics')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);

  assert.strictEqual(res.status, 200);
  const atRisk = res.body.data.atRisk;
  assert.ok(Array.isArray(atRisk));
  const lowEntry = atRisk.find((e) => e.reason === 'low_score');
  assert.ok(lowEntry, 'should have a low_score entry');
  assert.ok(lowEntry.studentName.includes('John'), `expected John, got ${lowEntry.studentName}`);
  assert.strictEqual(lowEntry.rollNumber, 'R001');
  // user-ok should NOT be at risk
  const okEntry = atRisk.find((e) => e.studentName && e.studentName.includes('Jane'));
  assert.ok(!okEntry, 'Jane (score 75) should not be at risk');
  analytics._deps = null;
});

// Test 4: atRisk — student with enrollment status 'registered' appears with reason 'not_active'
test('atRisk: student with enrollment status registered gets reason not_active', async () => {
  const enrollments = [
    { userId: 'user-reg', rollNumber: 'R010', status: 'registered' },
    { userId: 'user-act', rollNumber: 'R011', status: 'active' },
  ];

  const users = [
    { _id: 'user-reg', firstName: 'Alice', lastName: 'Reg' },
    { _id: 'user-act', firstName: 'Bob', lastName: 'Act' },
  ];

  analytics._deps = {
    CohortRollup: { findOne: async () => ({ byCompetency: [] }) },
    // No graded sessions for these students
    AssessmentSession: { find: async () => [] },
    InstitutionEnrollment: { find: async () => enrollments },
    User: { find: async () => users },
  };

  const res = await request(appAs('tpo_head'))
    .get('/api/institution/cohorts/c1/analytics')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);

  assert.strictEqual(res.status, 200);
  const atRisk = res.body.data.atRisk;
  assert.ok(Array.isArray(atRisk));
  const regEntry = atRisk.find((e) => e.reason === 'not_active');
  assert.ok(regEntry, 'should have a not_active entry');
  assert.ok(regEntry.studentName.includes('Alice'), `expected Alice, got ${regEntry.studentName}`);
  assert.strictEqual(regEntry.rollNumber, 'R010');
  // active student should NOT be at risk
  const actEntry = atRisk.find((e) => e.studentName && e.studentName.includes('Bob'));
  assert.ok(!actEntry, 'Bob (active) should not be at risk');
  analytics._deps = null;
});

// Test 5: no rollup → competencies returns empty array (graceful)
test('no rollup → competencies is empty array', async () => {
  analytics._deps = {
    CohortRollup: { findOne: async () => null },
    AssessmentSession: { find: async () => [] },
    InstitutionEnrollment: { find: async () => [] },
    User: { find: async () => [] },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/c1/analytics')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.data.competencies, []);
  analytics._deps = null;
});

// Test 6: Unauthenticated request → 401
test('GET /cohorts/:cohortId/analytics without auth → 401', async () => {
  const a = express(); a.use(express.json()); a.use('/api/institution', analytics);
  const res = await request(a).get('/api/institution/cohorts/c1/analytics');
  assert.strictEqual(res.status, 401);
});
