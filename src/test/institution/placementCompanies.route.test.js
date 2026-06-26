'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const router = require('../../routes/institution/studentAssessments');

function appWith(deps) {
  router._deps = deps;
  const a = express(); a.use(express.json());
  a.use('/api/v2/me', router);
  return a;
}
const authStub = (userId) => (req, _res, next) => { req.user = { userId }; next(); };

test('companies: returns drives for the student cohorts', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([{ cohortId: 'c1' }, { cohortId: 'c2' }]) }) },
    PlacementDrive: { find: (q) => { assert.deepStrictEqual(q.cohortId.$in, ['c1', 'c2']); return { sort: () => ({ lean: async () => ([{ _id: 'd1', name: 'Acme' }]) }) }; } },
  });
  const res = await request(app).get('/api/v2/me/placement/companies');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data[0].name, 'Acme');
  router._deps = null;
});

test('companies: empty when no enrollment', async () => {
  const app = appWith({ auth: authStub('stu1'), InstitutionEnrollment: { find: () => ({ lean: async () => ([]) }) } });
  const res = await request(app).get('/api/v2/me/placement/companies');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.data, []);
  router._deps = null;
});
