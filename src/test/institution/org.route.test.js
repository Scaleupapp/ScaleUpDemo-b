'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

// Stub _loadUser so no DB hit is needed in route-level tests
function stubLoadUser(institutionId, role) {
  institutionAuth._loadUser = async () => ({
    _id: 'u1',
    institutionId,
    role,
    status: 'active',
    tokenVersion: 0,
    scope: {},
  });
}

// Require org router AFTER setting up stub environment
const org = require('../../routes/institution/org');

function tok(institutionId, role) {
  return signInstitutionToken({ _id: 'u1', institutionId, role, tokenVersion: 0 });
}

function appAs(institutionId, role) {
  stubLoadUser(institutionId, role);
  const a = express();
  a.use(express.json());
  a.use('/api/institution', org);
  return a;
}

// ── (a) viewer POST /departments → 403 ─────────────────────────────────────

test('viewer POST /departments is forbidden (403)', async () => {
  const res = await request(appAs('inst-A', 'viewer'))
    .post('/api/institution/departments')
    .set('Authorization', `Bearer ${tok('inst-A', 'viewer')}`)
    .send({ name: 'CS', code: 'CS01', capabilityTracks: ['software'] });
  assert.strictEqual(res.status, 403);
});

// ── (b) tpo_head POST /departments → 200; institutionId from token ──────────

test('tpo_head POST /departments → 201 with institutionId from token (not body)', async () => {
  const tokenInstitutionId = 'token-inst-id';
  const bodyInstitutionId = 'injected-bad-inst-id';

  let capturedData = null;
  org._deps = {
    orgService: {
      createDepartment: async (scope, payload) => {
        capturedData = { scope, payload };
        return { _id: 'dept1', ...scope, ...payload };
      },
    },
  };

  stubLoadUser(tokenInstitutionId, 'tpo_head');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', org);

  const res = await request(a)
    .post('/api/institution/departments')
    .set('Authorization', `Bearer ${tok(tokenInstitutionId, 'tpo_head')}`)
    .send({ name: 'CS', code: 'CS01', capabilityTracks: ['software'], institutionId: bodyInstitutionId });

  assert.strictEqual(res.status, 201);
  assert.ok(res.body.success);
  // institutionId in the scope must come from the token, not the body
  assert.strictEqual(String(capturedData.scope.institutionId), tokenInstitutionId);
  // body institutionId must NOT have leaked into the scope
  assert.notStrictEqual(String(capturedData.scope.institutionId), bodyInstitutionId);

  org._deps = null;
});

// ── (b2) createDepartment with duplicate code → 409 ALREADY_EXISTS ───────────

test('POST /departments with a duplicate code → 409 ALREADY_EXISTS', async () => {
  org._deps = {
    orgService: {
      createDepartment: async () => { const e = new Error('E11000 dup key'); e.code = 11000; throw e; },
    },
  };

  stubLoadUser('inst-dup', 'tpo_head');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', org);

  const res = await request(a)
    .post('/api/institution/departments')
    .set('Authorization', `Bearer ${tok('inst-dup', 'tpo_head')}`)
    .send({ name: 'CS', code: 'CS01' });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'ALREADY_EXISTS');
  // raw mongo error must NOT leak to the client
  assert.ok(!String(res.body.message || '').includes('E11000'));

  org._deps = null;
});

// ── (c) createCohort with departmentId not in institution → 400/404 ─────────

test('createCohort with unknown departmentId returns 4xx (DEPARTMENT_NOT_FOUND)', async () => {
  org._deps = {
    orgService: {
      createCohort: async () => {
        throw new Error('DEPARTMENT_NOT_FOUND');
      },
    },
  };

  stubLoadUser('inst-A', 'tpo_head');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', org);

  const res = await request(a)
    .post('/api/institution/cohorts')
    .set('Authorization', `Bearer ${tok('inst-A', 'tpo_head')}`)
    .send({ departmentId: 'nonexistent-dept', year: 'final', label: 'Batch 2024' });

  assert.ok(res.status === 400 || res.status === 404, `expected 400 or 404, got ${res.status}`);
  assert.ok(!res.body.success);

  org._deps = null;
});

// ── (d) GET lists are scoped — institutionId comes from token ────────────────

test('GET /departments returns list scoped to token institutionId', async () => {
  const tokenInstitutionId = 'scoped-inst';
  let capturedScope = null;

  org._deps = {
    orgService: {
      listDepartments: async (scope) => {
        capturedScope = scope;
        return [{ _id: 'd1', ...scope, name: 'CS', code: 'CS01' }];
      },
    },
  };

  stubLoadUser(tokenInstitutionId, 'viewer');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', org);

  const res = await request(a)
    .get('/api/institution/departments')
    .set('Authorization', `Bearer ${tok(tokenInstitutionId, 'viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.success);
  assert.ok(Array.isArray(res.body.data));
  // scope passed to service must include token institutionId
  assert.strictEqual(String(capturedScope.institutionId), tokenInstitutionId);

  org._deps = null;
});

test('GET /cohorts returns list scoped to token institutionId, optionally filtered by departmentId', async () => {
  const tokenInstitutionId = 'scoped-inst-2';
  let capturedScope = null;
  let capturedFilters = null;

  org._deps = {
    orgService: {
      listCohorts: async (scope, filters) => {
        capturedScope = scope;
        capturedFilters = filters;
        return [{ _id: 'coh1', ...scope, ...filters, label: 'Batch 2024' }];
      },
    },
  };

  stubLoadUser(tokenInstitutionId, 'tpo_coordinator');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', org);

  const res = await request(a)
    .get('/api/institution/cohorts?departmentId=dept-X')
    .set('Authorization', `Bearer ${tok(tokenInstitutionId, 'tpo_coordinator')}`);

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.success);
  assert.ok(Array.isArray(res.body.data));
  assert.strictEqual(String(capturedScope.institutionId), tokenInstitutionId);
  assert.strictEqual(capturedFilters.departmentId, 'dept-X');

  org._deps = null;
});

// ── institution_admin POST /departments also works ───────────────────────────

test('institution_admin POST /departments → 201', async () => {
  org._deps = {
    orgService: {
      createDepartment: async (scope, payload) => ({ _id: 'dept2', ...scope, ...payload }),
    },
  };

  stubLoadUser('inst-B', 'institution_admin');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', org);

  const res = await request(a)
    .post('/api/institution/departments')
    .set('Authorization', `Bearer ${tok('inst-B', 'institution_admin')}`)
    .send({ name: 'Mechanical', code: 'MECH', capabilityTracks: [] });

  assert.strictEqual(res.status, 201);
  assert.ok(res.body.success);

  org._deps = null;
});
