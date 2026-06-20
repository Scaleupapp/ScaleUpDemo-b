'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

// Stub _loadUser so no DB hit is needed in route-level tests
function stubLoadUser(role) {
  institutionAuth._loadUser = async () => ({
    _id: 'u1',
    institutionId: 'i1',
    role,
    status: 'active',
    tokenVersion: 0,
    scope: {},
  });
}

// Require rosters router AFTER setting up the stub environment
const rosters = require('../../routes/institution/rosters');

function appAs(role) {
  stubLoadUser(role);
  const a = express();
  a.use(express.json());
  a.use('/api/institution', rosters);
  return a;
}

function tok(role) {
  return signInstitutionToken({ _id: 'u1', institutionId: 'i1', role, tokenVersion: 0 });
}

// ── Role-gate tests (maker-checker) ────────────────────────────────────────

test('upload is forbidden for a viewer (maker-checker: needs roster.upload)', async () => {
  const res = await request(appAs('viewer'))
    .post('/api/institution/rosters/upload')
    .set('Authorization', `Bearer ${tok('viewer')}`)
    .send({ departmentId: 'd1', cohortId: 'c1', rows: [] });
  assert.strictEqual(res.status, 403);
});

test('upload is forbidden for a faculty (maker-checker: needs roster.upload)', async () => {
  const res = await request(appAs('faculty'))
    .post('/api/institution/rosters/upload')
    .set('Authorization', `Bearer ${tok('faculty')}`)
    .send({ departmentId: 'd1', cohortId: 'c1', rows: [] });
  assert.strictEqual(res.status, 403);
});

test('approve is forbidden for a tpo_coordinator (maker-checker: needs tpo_head or institution_admin)', async () => {
  const res = await request(appAs('tpo_coordinator'))
    .post('/api/institution/rosters/someuploadid/approve')
    .set('Authorization', `Bearer ${tok('tpo_coordinator')}`)
    .send({});
  assert.strictEqual(res.status, 403);
});

test('funnel is forbidden for an unauthenticated caller', async () => {
  const a = express();
  a.use(express.json());
  a.use('/api/institution', rosters);
  const res = await request(a)
    .get('/api/institution/cohorts/c1/funnel');
  assert.strictEqual(res.status, 401);
});

// ── Happy-path upload test with model stubs ─────────────────────────────────
// We inject deps through the rosters router's exported _deps seam.

test('upload returns 200 with rosterUploadId and preview for tpo_coordinator (stubbed models)', async () => {
  // Build a fake institution with seats
  let savedRosterUpload = null;
  const fakeInstitution = { name: 'Test College', seatsLicensed: 100, seatsUsed: 0 };
  const fakeRosterUploadInstance = {
    _id: 'ru1',
    save: async function () { savedRosterUpload = this; },
  };

  rosters._deps = {
    Institution: {
      findOne: async () => fakeInstitution,
    },
    RosterUpload: function (data) {
      Object.assign(fakeRosterUploadInstance, data);
      return fakeRosterUploadInstance;
    },
  };

  stubLoadUser('tpo_coordinator');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', rosters);

  const rows = [
    { name: 'Alice', rollNumber: 'R001', email: 'alice@college.edu', phone: '9876543210' },
    { name: 'Bob', rollNumber: 'R002', email: 'bob@college.edu', phone: '9876543211' },
  ];

  const res = await request(a)
    .post('/api/institution/rosters/upload')
    .set('Authorization', `Bearer ${tok('tpo_coordinator')}`)
    .send({ departmentId: 'd1', cohortId: 'c1', rows });

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.success);
  assert.ok(res.body.data.rosterUploadId, 'should return rosterUploadId');
  assert.strictEqual(res.body.data.preview.length, 2);
  assert.strictEqual(res.body.data.counts.valid, 2);
  assert.strictEqual(res.body.data.errors.length, 0);

  // Clean up dep injection
  rosters._deps = null;
});
