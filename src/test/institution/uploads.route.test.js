'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');
function stubLoadUser(institutionId, role) { institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId, role, status: 'active', tokenVersion: 0, scope: {} }); }
const uploads = require('../../routes/institution/uploads');
function tok(i, r) { return signInstitutionToken({ _id: 'u1', institutionId: i, role: r, tokenVersion: 0 }); }
function appAs(i, r) { stubLoadUser(i, r); const a = express(); a.use(express.json()); a.use('/api/institution', uploads); return a; }

test('viewer cannot request an upload url (403)', async () => {
  const res = await request(appAs('inst-A', 'viewer')).post('/api/institution/uploads/sign')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`).send({ fileName: 'a.pdf', contentType: 'application/pdf' });
  assert.strictEqual(res.status, 403);
});
test('tpo_coordinator gets a presigned url + scoped key', async () => {
  uploads._deps = { generateUploadURL: async (key, ct) => `https://signed/${key}?ct=${ct}` };
  const res = await request(appAs('inst-A', 'tpo_coordinator')).post('/api/institution/uploads/sign')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_coordinator')}`).send({ fileName: 'my notes.pdf', contentType: 'application/pdf' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.s3Key.startsWith('institution/inst-A/uploads/'));
  assert.ok(res.body.data.uploadUrl.includes('signed/institution/inst-A/uploads/'));
  uploads._deps = null;
});
test('missing fileName → 400', async () => {
  const res = await request(appAs('inst-A', 'tpo_head')).post('/api/institution/uploads/sign')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`).send({ contentType: 'application/pdf' });
  assert.strictEqual(res.status, 400);
});
