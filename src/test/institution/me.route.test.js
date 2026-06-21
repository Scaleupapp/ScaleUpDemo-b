'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

// Stub _loadUser so no DB hit is needed
institutionAuth._loadUser = async () => ({
  _id: 'userA',
  institutionId: 'iA',
  role: 'tpo_head',
  status: 'active',
  tokenVersion: 0,
  scope: { departmentIds: [] },
});

const me = require('../../routes/institution/me');

// Fake data
const fakeUser = {
  _id: 'userA',
  name: 'Alice TPO',
  email: 'alice@college.edu',
  role: 'tpo_head',
  scope: { departmentIds: [] },
};
const fakeInstitution = {
  _id: 'iA',
  name: 'Demo College',
  logoUrl: 'https://example.com/logo.png',
  brandColor: '#123456',
  seatsLicensed: 200,
  seatsUsed: 42,
};

// Inject stubs
me._deps = {
  InstitutionUser: {
    findById: () => ({
      select: () => ({ lean: async () => fakeUser }),
    }),
  },
  Institution: {
    findOne: (filter) => ({
      _capturedFilter: filter,
      select: function () { return { lean: async () => ({ ...fakeInstitution, _capturedFilter: this._capturedFilter }) }; },
    }),
  },
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/institution/me', me);
  return a;
}

function tok() {
  return signInstitutionToken({ _id: 'userA', institutionId: 'iA', role: 'tpo_head', tokenVersion: 0 });
}

test('GET /api/institution/me returns 401 without token', async () => {
  const res = await request(app()).get('/api/institution/me');
  assert.strictEqual(res.status, 401);
});

test('GET /api/institution/me returns 200 with correct shape for tpo_head', async () => {
  // Capture the filter passed to Institution.findOne
  let capturedFilter = null;
  me._deps = {
    InstitutionUser: {
      findById: () => ({
        select: () => ({ lean: async () => fakeUser }),
      }),
    },
    Institution: {
      findOne: (filter) => {
        capturedFilter = filter;
        return {
          select: () => ({ lean: async () => fakeInstitution }),
        };
      },
    },
  };

  const res = await request(app())
    .get('/api/institution/me')
    .set('Authorization', `Bearer ${tok()}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);

  // Check user shape
  const { user, institution } = res.body.data;
  assert.strictEqual(user.id, String(fakeUser._id));
  assert.strictEqual(user.name, fakeUser.name);
  assert.strictEqual(user.email, fakeUser.email);
  assert.strictEqual(user.role, fakeUser.role);
  assert.deepStrictEqual(user.scope, fakeUser.scope);

  // Check institution shape
  assert.strictEqual(institution.id, String(fakeInstitution._id));
  assert.strictEqual(institution.name, fakeInstitution.name);
  assert.strictEqual(institution.logoUrl, fakeInstitution.logoUrl);
  assert.strictEqual(institution.brandColor, fakeInstitution.brandColor);
  assert.strictEqual(institution.seatsLicensed, fakeInstitution.seatsLicensed);
  assert.strictEqual(institution.seatsUsed, fakeInstitution.seatsUsed);

  // Verify institutionId from token was used in the Institution query
  assert.ok(capturedFilter, 'Institution.findOne should have been called');
  assert.strictEqual(capturedFilter.institutionId, 'iA', 'Institution query must be scoped to token institutionId');
});

test('GET /api/institution/me returns 404 if user not found', async () => {
  me._deps = {
    InstitutionUser: {
      findById: () => ({
        select: () => ({ lean: async () => null }),
      }),
    },
    Institution: {
      findOne: () => ({
        select: () => ({ lean: async () => fakeInstitution }),
      }),
    },
  };

  const res = await request(app())
    .get('/api/institution/me')
    .set('Authorization', `Bearer ${tok()}`);

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.success, false);
  assert.ok(res.body.message.includes('User not found'));
});

test('GET /api/institution/me returns 404 if institution not found', async () => {
  me._deps = {
    InstitutionUser: {
      findById: () => ({
        select: () => ({ lean: async () => fakeUser }),
      }),
    },
    Institution: {
      findOne: () => ({
        select: () => ({ lean: async () => null }),
      }),
    },
  };

  const res = await request(app())
    .get('/api/institution/me')
    .set('Authorization', `Bearer ${tok()}`);

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.success, false);
  assert.ok(res.body.message.includes('Institution not found'));
});
