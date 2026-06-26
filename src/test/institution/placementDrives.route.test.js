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
const org = require('../../routes/institution/org');
function tok(institutionId, role) { return signInstitutionToken({ _id: 'u1', institutionId, role, tokenVersion: 0 }); }
function appAs(institutionId, role) {
  stubLoadUser(institutionId, role);
  const a = express(); a.use(express.json()); a.use('/api/institution', org); return a;
}

test('viewer cannot create a drive (403)', async () => {
  const res = await request(appAs('inst-A', 'viewer'))
    .post('/api/institution/cohorts/c1/drives')
    .set('Authorization', `Bearer ${tok('inst-A', 'viewer')}`)
    .send({ name: 'Acme' });
  assert.strictEqual(res.status, 403);
  org._deps = null;
});

test('tpo_coordinator creates a drive; scope.institutionId from token, cohortId from path', async () => {
  let captured = null;
  org._deps = { orgService: { createDrive: async (scope, cohortId, body) => { captured = { scope, cohortId, body }; return { _id: 'd1', ...body }; } } };
  const res = await request(appAs('inst-A', 'tpo_coordinator'))
    .post('/api/institution/cohorts/c1/drives')
    .set('Authorization', `Bearer ${tok('inst-A', 'tpo_coordinator')}`)
    .send({ name: 'Acme', role: 'SDE', institutionId: 'inst-EVIL' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(captured.scope.institutionId, 'inst-A');
  assert.strictEqual(captured.cohortId, 'c1');
  assert.strictEqual(captured.body.name, 'Acme');
  org._deps = null;
});

test('GET drives is allowed for viewer and returns the service list', async () => {
  org._deps = { orgService: { listDrives: async () => ([{ _id: 'd1', name: 'Acme' }]) } };
  const res = await request(appAs('inst-A', 'viewer'))
    .get('/api/institution/cohorts/c1/drives')
    .set('Authorization', `Bearer ${tok('inst-A', 'viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data[0].name, 'Acme');
  org._deps = null;
});

test('PATCH unknown drive → 404', async () => {
  org._deps = { orgService: { updateDrive: async () => { throw new Error('DRIVE_NOT_FOUND'); } } };
  const res = await request(appAs('inst-A', 'tpo_head'))
    .patch('/api/institution/cohorts/c1/drives/dX')
    .set('Authorization', `Bearer ${tok('inst-A', 'tpo_head')}`)
    .send({ status: 'closed' });
  assert.strictEqual(res.status, 404);
  org._deps = null;
});
