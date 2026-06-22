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

test('upload returns 201 with rosterUploadId and preview for tpo_coordinator (stubbed models)', async () => {
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

  assert.strictEqual(res.status, 201);
  assert.ok(res.body.success);
  assert.ok(res.body.data.rosterUploadId, 'should return rosterUploadId');
  assert.strictEqual(res.body.data.preview.length, 2);
  assert.strictEqual(res.body.data.counts.valid, 2);
  assert.strictEqual(res.body.data.errors.length, 0);

  // Clean up dep injection
  rosters._deps = null;
});

// ── Idempotency: double-approve returns 409 on second call ──────────────────

test('approve: first call succeeds; second call returns 409 (commitRoster called only once)', async () => {
  // Stateful upload object — its status persists across calls just like a real document.
  const upload = {
    _id: 'ru-idem',
    institutionId: 'i1',
    departmentId: 'd1',
    cohortId: 'c1',
    status: 'validated',
    validData: [{ name: 'Alice', rollNumber: 'R001', email: 'alice@college.edu', phone: '9876543210' }],
    save: async function () { /* mutations to `this` already applied by the route */ },
  };

  let commitRosterCallCount = 0;

  rosters._deps = {
    Institution: { findOne: async () => ({ name: 'Test College' }) },
    // findOne returns the same stateful object; .select('+validData') chain is a no-op wrapper
    RosterUpload: {
      findOne: () => ({
        select: () => Promise.resolve(upload),
      }),
    },
    PendingStudent: { countDocuments: async () => 0 },
    InstitutionEnrollment: { countDocuments: async () => 0 },
  };

  // Stub commitRoster and sendInvites on the module objects (route calls via rosterService.commitRoster)
  const rosterService = require('../../services/institution/rosterService');
  const inviteService = require('../../services/institution/inviteService');
  const origCommit = rosterService.commitRoster;
  const origSend = inviteService.sendInvites;

  rosterService.commitRoster = async ({ rosterUpload }) => {
    commitRosterCallCount += 1;
    // Mimic what the real commitRoster does: transition status and save
    rosterUpload.status = 'committed';
    await rosterUpload.save();
    return { created: 1, pending: [] };
  };
  inviteService.sendInvites = async () => ({ invited: 1 });

  stubLoadUser('tpo_head');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', rosters);

  // First approve — must succeed
  const res1 = await request(a)
    .post('/api/institution/rosters/ru-idem/approve')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({});
  assert.strictEqual(res1.status, 200, `first approve should be 200 (got ${res1.status}: ${JSON.stringify(res1.body)})`);

  // Second approve — status is now 'committed' (not 'validated'), must return 409
  const res2 = await request(a)
    .post('/api/institution/rosters/ru-idem/approve')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({});
  assert.strictEqual(res2.status, 409, `second approve should be 409 (got ${res2.status}: ${JSON.stringify(res2.body)})`);

  // commitRoster must have been called exactly once
  assert.strictEqual(commitRosterCallCount, 1, 'commitRoster should be called exactly once');

  // Restore originals and clean up
  rosterService.commitRoster = origCommit;
  inviteService.sendInvites = origSend;
  rosters._deps = null;
});

// ── GET /rosters/pending (approvers list validated uploads) ──────────────────

test('GET /rosters/pending returns validated uploads scoped to the token institution', async () => {
  let capturedFilter = null;
  const fakeUploads = [
    { _id: 'ru1', departmentId: 'd1', cohortId: 'c1', rowCount: 3, validRows: 2, errors: [{ row: 3, field: 'email', reason: 'missing email' }] },
  ];
  rosters._deps = {
    RosterUpload: {
      find: (filter) => {
        capturedFilter = filter;
        return { select: () => ({ sort: () => ({ limit: () => Promise.resolve(fakeUploads) }) }) };
      },
    },
  };

  const res = await request(appAs('tpo_head'))
    .get('/api/institution/rosters/pending')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.success);
  assert.strictEqual(res.body.data.length, 1);
  assert.strictEqual(res.body.data[0]._id, 'ru1');
  // scoped to the token institution + only validated status
  assert.strictEqual(String(capturedFilter.institutionId), 'i1');
  assert.strictEqual(capturedFilter.status, 'validated');

  rosters._deps = null;
});

test('GET /rosters/pending is allowed for institution_admin', async () => {
  rosters._deps = {
    RosterUpload: { find: () => ({ select: () => ({ sort: () => ({ limit: () => Promise.resolve([]) }) }) }) },
  };
  const res = await request(appAs('institution_admin'))
    .get('/api/institution/rosters/pending')
    .set('Authorization', `Bearer ${tok('institution_admin')}`);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  rosters._deps = null;
});

test('GET /rosters/pending is forbidden for tpo_coordinator / faculty / viewer', async () => {
  for (const role of ['tpo_coordinator', 'faculty', 'viewer']) {
    const res = await request(appAs(role))
      .get('/api/institution/rosters/pending')
      .set('Authorization', `Bearer ${tok(role)}`);
    assert.strictEqual(res.status, 403, `expected 403 for ${role}, got ${res.status}`);
  }
});
