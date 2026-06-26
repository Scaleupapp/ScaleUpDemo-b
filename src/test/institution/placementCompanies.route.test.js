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

test('companies: returns drives for the student cohorts, filtered by institutionId and cohortId', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: {
      find: () => ({
        lean: async () => ([
          { cohortId: 'c1', institutionId: 'inst1' },
          { cohortId: 'c2', institutionId: 'inst1' },
        ]),
      }),
    },
    PlacementDrive: {
      find: (q) => {
        assert.deepStrictEqual(q.cohortId.$in, ['c1', 'c2'], 'cohortId.$in should match enrolled cohorts');
        assert.deepStrictEqual(q.institutionId.$in, ['inst1'], 'institutionId.$in should match enrollment institutions');
        return { lean: async () => ([{ _id: 'd1', name: 'Acme', driveDate: new Date('2026-09-01') }]) };
      },
    },
  });
  const res = await request(app).get('/api/v2/me/placement/companies');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data[0].name, 'Acme');
  router._deps = null;
});

test('companies: empty when no enrollment', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([]) }) },
  });
  const res = await request(app).get('/api/v2/me/placement/companies');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.data, []);
  router._deps = null;
});

test('companies: null-date drives sort after dated drives', async () => {
  const datedDrive = { _id: 'd1', name: 'Dated Corp', driveDate: new Date('2026-10-01'), createdAt: new Date('2026-01-01') };
  const nullDateDrive = { _id: 'd2', name: 'No-Date Corp', driveDate: null, createdAt: new Date('2026-01-02') };
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: {
      find: () => ({ lean: async () => ([{ cohortId: 'c1', institutionId: 'inst1' }]) }),
    },
    PlacementDrive: {
      // Return null-date drive first from "DB" to confirm JS re-sort works
      find: () => ({ lean: async () => ([nullDateDrive, datedDrive]) }),
    },
  });
  const res = await request(app).get('/api/v2/me/placement/companies');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.length, 2);
  assert.strictEqual(res.body.data[0].name, 'Dated Corp', 'dated drive should come first');
  assert.strictEqual(res.body.data[1].name, 'No-Date Corp', 'null-date drive should come last');
  router._deps = null;
});

test('companies: returns 401 when unauthenticated (no auth stub injected)', async () => {
  // With no auth stub the real D2C auth middleware is used.
  // Sending no Authorization header → 401.
  const app = appWith({
    // auth not provided — falls back to real auth middleware
    InstitutionEnrollment: { find: () => ({ lean: async () => [] }) },
    PlacementDrive: { find: () => ({ lean: async () => [] }) },
  });
  const res = await request(app).get('/api/v2/me/placement/companies');
  assert.strictEqual(res.status, 401);
  router._deps = null;
});
