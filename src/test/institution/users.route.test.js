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

// Require users router AFTER setting up stub environment
const users = require('../../routes/institution/users');

function tok(institutionId, role) {
  return signInstitutionToken({ _id: 'u1', institutionId, role, tokenVersion: 0 });
}

function appAs(institutionId, role) {
  stubLoadUser(institutionId, role);
  const a = express();
  a.use(express.json());
  a.use('/api/institution', users);
  return a;
}

// ── (a) institution_admin invites tpo_head → 200, no token/hash fields ────────

test('institution_admin POST /users invites tpo_head → 201, no token/hash fields', async () => {
  const INST = 'inst-A';
  const fakeUser = { _id: 'invited-1', email: 'tpo@test.com', role: 'tpo_head', status: 'invited' };

  users._svc = {
    inviteUser: async (args) => fakeUser,
  };

  stubLoadUser(INST, 'institution_admin');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', users);

  const res = await request(a)
    .post('/api/institution/users')
    .set('Authorization', `Bearer ${tok(INST, 'institution_admin')}`)
    .send({ email: 'tpo@test.com', role: 'tpo_head', scope: {} });

  assert.strictEqual(res.status, 201);
  assert.ok(res.body.success);
  assert.ok(res.body.data);
  // id, email, role, status must be present
  assert.ok(res.body.data.id || res.body.data._id || res.body.data.email);
  assert.strictEqual(res.body.data.email, 'tpo@test.com');
  assert.strictEqual(res.body.data.role, 'tpo_head');
  assert.strictEqual(res.body.data.status, 'invited');
  // NEVER return authToken/hash
  assert.strictEqual(res.body.data.authTokenHash, undefined);
  assert.strictEqual(res.body.data.authToken, undefined);
  assert.strictEqual(res.body.data.passwordHash, undefined);
  assert.strictEqual(res.body.data.tokenVersion, undefined);

  users._svc = null;
});

// ── (b) tpo_head inviting institution_admin → 403 FORBIDDEN_ROLE ─────────────

test('tpo_head POST /users inviting institution_admin → 403 FORBIDDEN_ROLE', async () => {
  const INST = 'inst-B';

  users._svc = {
    inviteUser: async (args) => {
      throw new Error('FORBIDDEN_ROLE');
    },
  };

  stubLoadUser(INST, 'tpo_head');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', users);

  const res = await request(a)
    .post('/api/institution/users')
    .set('Authorization', `Bearer ${tok(INST, 'tpo_head')}`)
    .send({ email: 'admin@test.com', role: 'institution_admin', scope: {} });

  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.code, 'FORBIDDEN_ROLE');

  users._svc = null;
});

// ── (b2) invalid role → 400 INVALID_ROLE ─────────────────────────────────────

test('POST /users with unknown role → 400 INVALID_ROLE', async () => {
  const INST = 'inst-B2';
  users._svc = { inviteUser: async () => { throw new Error('INVALID_ROLE'); } };
  stubLoadUser(INST, 'institution_admin');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', users);

  const res = await request(a)
    .post('/api/institution/users')
    .set('Authorization', `Bearer ${tok(INST, 'institution_admin')}`)
    .send({ email: 'x@test.com', role: 'superuser', scope: {} });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.code, 'INVALID_ROLE');
  users._svc = null;
});

// ── (b3) duplicate email (Mongo 11000) → 409 ALREADY_EXISTS ───────────────────

test('POST /users with duplicate email → 409 ALREADY_EXISTS', async () => {
  const INST = 'inst-B3';
  users._svc = { inviteUser: async () => { const e = new Error('E11000 dup'); e.code = 11000; throw e; } };
  stubLoadUser(INST, 'institution_admin');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', users);

  const res = await request(a)
    .post('/api/institution/users')
    .set('Authorization', `Bearer ${tok(INST, 'institution_admin')}`)
    .send({ email: 'dupe@test.com', role: 'faculty', scope: {} });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'ALREADY_EXISTS');
  // raw mongo error must NOT leak
  assert.ok(!String(res.body.message || '').includes('E11000'));
  users._svc = null;
});

// ── (c) viewer POST /users → 403 (role gate) ─────────────────────────────────

test('viewer POST /users → 403 (role gate)', async () => {
  const res = await request(appAs('inst-C', 'viewer'))
    .post('/api/institution/users')
    .set('Authorization', `Bearer ${tok('inst-C', 'viewer')}`)
    .send({ email: 'someone@test.com', role: 'tpo_head', scope: {} });

  assert.strictEqual(res.status, 403);
});

// ── (d) GET /users returns scoped users with only safe fields ─────────────────

test('GET /users returns scoped users with only safe fields', async () => {
  const INST = 'inst-D';

  // Simulate a model that returns users with sensitive fields filtered out
  const mockUsers = [
    { _id: 'u10', name: 'Alice', email: 'alice@test.com', role: 'tpo_head', status: 'active' },
    { _id: 'u11', name: 'Bob', email: 'bob@test.com', role: 'viewer', status: 'active' },
  ];

  users._svc = {
    listUsers: async (institutionId) => mockUsers,
  };

  stubLoadUser(INST, 'viewer');
  const a = express();
  a.use(express.json());
  a.use('/api/institution', users);

  const res = await request(a)
    .get('/api/institution/users')
    .set('Authorization', `Bearer ${tok(INST, 'viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.success);
  assert.ok(Array.isArray(res.body.data));
  assert.strictEqual(res.body.data.length, 2);

  // Ensure sensitive fields are absent
  for (const u of res.body.data) {
    assert.strictEqual(u.authTokenHash, undefined);
    assert.strictEqual(u.passwordHash, undefined);
    assert.strictEqual(u.tokenVersion, undefined);
  }

  users._svc = null;
});
