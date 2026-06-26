'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test'); const assert = require('node:assert');
const express = require('express'); const request = require('supertest');
const router = require('../../routes/institution/studentAssessments');
function appWith(deps) { router._deps = deps; const a = express(); a.use(express.json()); a.use('/api/v2/me', router); return a; }
const authStub = (userId) => (req, _res, next) => { req.user = { userId }; next(); };

test('practice: recommends weakest competencies from latest graded MCQ session', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([{ cohortId: 'c1' }]) }) },
    AssessmentSession: { findOne: () => ({ sort: () => ({ lean: async () => ({
      _id: 'sess1', status: 'graded',
      result: { raw: { competencyBreakdown: [
        { competency: 'Project Tracking', percentage: 30 },
        { competency: 'Risk Management', percentage: 80 },
        { competency: 'Stakeholder Comms', percentage: 45 },
      ] } },
    }) }) }) },
  });
  const res = await request(app).get('/api/v2/me/placement/practice');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.hasAssessment, true);
  // weakest first
  assert.strictEqual(res.body.data.recommendations[0].competency, 'Project Tracking');
  assert.strictEqual(res.body.data.recommendations[0].score, 30);
  assert.strictEqual(res.body.data.recommendations[0].suggestedType, 'quiz');
  assert.strictEqual(res.body.data.recommendations[0].topic, 'Project Tracking');
  assert.ok(res.body.data.recommendations.length <= 3);
  // types always present
  assert.deepStrictEqual(res.body.data.types.map((t) => t.key), ['quiz', 'drill', 'capstone', 'interview']);
  router._deps = null;
});

test('practice: no graded session → hasAssessment false, empty recommendations, types still present', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([{ cohortId: 'c1' }]) }) },
    AssessmentSession: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) },
  });
  const res = await request(app).get('/api/v2/me/placement/practice');
  assert.strictEqual(res.body.data.hasAssessment, false);
  assert.deepStrictEqual(res.body.data.recommendations, []);
  assert.strictEqual(res.body.data.types.length, 4);
  router._deps = null;
});

test('practice: empty when no enrollment', async () => {
  const app = appWith({ auth: authStub('stu1'), InstitutionEnrollment: { find: () => ({ lean: async () => ([]) }) } });
  const res = await request(app).get('/api/v2/me/placement/practice');
  assert.strictEqual(res.body.data.hasAssessment, false);
  assert.deepStrictEqual(res.body.data.recommendations, []);
  router._deps = null;
});
