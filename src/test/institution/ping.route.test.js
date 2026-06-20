process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');
const router = require('../../routes/institution');

institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId: 'i1', role: 'tpo_head', status: 'active', tokenVersion: 0, scope: {} });
function app() { const a = express(); a.use(express.json()); a.use('/api/institution', router); return a; }

test('GET /ping returns scope for an authed institution user', async () => {
  const token = signInstitutionToken({ _id: 'u1', institutionId: 'i1', role: 'tpo_head', tokenVersion: 0 });
  const res = await request(app()).get('/api/institution/ping').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.data, { ok: true, institutionId: 'i1', role: 'tpo_head' });
});

test('GET /ping 401s without a token', async () => {
  const res = await request(app()).get('/api/institution/ping');
  assert.strictEqual(res.status, 401);
});
