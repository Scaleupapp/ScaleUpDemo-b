'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

function stubLoadUser(institutionId, role) {
  institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId, role, status: 'active', tokenVersion: 0, scope: {} });
}

const notices = require('../../routes/institution/notices');

function tok(i, r) { return signInstitutionToken({ _id: 'u1', institutionId: i, role: r, tokenVersion: 0 }); }
function appAs(i, r) { stubLoadUser(i, r); const a = express(); a.use(express.json()); a.use('/api/institution', notices); return a; }

test('viewer cannot create a notice (403)', async () => {
  const res = await request(appAs('inst-A','viewer')).post('/api/institution/cohorts/c1/notices')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`).send({ title: 'T', body: 'B' });
  assert.strictEqual(res.status, 403); notices._deps = null;
});
test('tpo_coordinator creates notice; scope from token, cohort from path', async () => {
  let captured = null;
  notices._deps = { noticeService: { createNotice: async (scope, cohortId, body) => { captured = { scope, cohortId, body }; return { _id: 'n1', ...body }; } } };
  const res = await request(appAs('inst-A','tpo_coordinator')).post('/api/institution/cohorts/c1/notices')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_coordinator')}`).send({ title: 'T', body: 'B', pinned: true, institutionId: 'EVIL' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(captured.scope.institutionId, 'inst-A');
  assert.strictEqual(captured.cohortId, 'c1');
  assert.strictEqual(captured.body.title, 'T');
  notices._deps = null;
});
test('GET notices returns service payload (any role)', async () => {
  notices._deps = { noticeService: { listNotices: async () => ({ notices: [{ _id: 'n1', title: 'T', readCount: 2 }], total: 5 }) } };
  const res = await request(appAs('inst-A','viewer')).get('/api/institution/cohorts/c1/notices')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.notices[0].readCount, 2);
  assert.strictEqual(res.body.data.total, 5);
  notices._deps = null;
});
test('DELETE unknown notice → 404', async () => {
  notices._deps = { noticeService: { deleteNotice: async () => { throw new Error('NOTICE_NOT_FOUND'); } } };
  const res = await request(appAs('inst-A','tpo_head')).delete('/api/institution/cohorts/c1/notices/nX')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`);
  assert.strictEqual(res.status, 404); notices._deps = null;
});
