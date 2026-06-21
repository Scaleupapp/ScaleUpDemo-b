// src/test/institution/auth.route.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

// Stub the rate limiter before importing the router
const _rlPath = require.resolve('../../middleware/rateLimiter');
require.cache[_rlPath] = { id: _rlPath, filename: _rlPath, loaded: true, exports: () => (req, res, next) => next() };

const authRouter = require('../../routes/institution/auth');

authRouter._svc.registerInstitution = async () => ({ ok: true, institutionId: 'i1' });
authRouter._svc.verify = async (t) => {
  if (t === 'good') return { token: 'JWT', institutionId: 'i1', role: 'institution_admin' };
  throw new Error('TOKEN_INVALID');
};
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/institution/auth', authRouter);
  return a;
}

test('POST /register returns institutionId', async () => {
  const res = await request(app()).post('/api/institution/auth/register').send({ institutionName: 'X', adminEmail: 'a@x.edu' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.institutionId, 'i1');
});

test('POST /verify returns a token for a good link, 400 for a bad one', async () => {
  const ok = await request(app()).post('/api/institution/auth/verify').send({ token: 'good' });
  assert.strictEqual(ok.body.data.token, 'JWT');
  const bad = await request(app()).post('/api/institution/auth/verify').send({ token: 'bad' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.code, 'TOKEN_INVALID');
});
