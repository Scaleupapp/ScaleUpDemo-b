'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

function stubLoadUser(role) {
  institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId: 'i1', role, status: 'active', tokenVersion: 0, scope: {} });
}
const templates = require('../../routes/institution/objectiveTemplates');
function tok(role) { return signInstitutionToken({ _id: 'u1', institutionId: 'i1', role, tokenVersion: 0 }); }
function appAs(role) {
  stubLoadUser(role);
  const a = express(); a.use(express.json()); a.use('/api/institution', templates); return a;
}

test('tpo_head POST /objective-templates → 201, scoped to token institution', async () => {
  let captured = null;
  templates._deps = { objectiveTemplateService: { createTemplate: async (scope, payload) => { captured = { scope, payload }; return { _id: 't1', ...scope, ...payload }; } } };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/objective-templates')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ label: 'Software 2026', objectiveType: 'interview_preparation', institutionId: 'EVIL', competencies: [{ name: 'DSA', weight: 9 }] });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(String(captured.scope.institutionId), 'i1');     // from token
  assert.notStrictEqual(String(captured.scope.institutionId), 'EVIL'); // body cannot override
  assert.strictEqual(captured.payload.createdBy, 'u1');
  templates._deps = null;
});

test('POST /objective-templates without label → 400 VALIDATION', async () => {
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/objective-templates')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ objectiveType: 'upskilling' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'VALIDATION');
});

test('viewer POST /objective-templates → 403 (role gate)', async () => {
  const res = await request(appAs('viewer'))
    .post('/api/institution/objective-templates')
    .set('Authorization', `Bearer ${tok('viewer')}`)
    .send({ label: 'X', objectiveType: 'upskilling' });
  assert.strictEqual(res.status, 403);
});

test('GET /objective-templates → 200 scoped list (any role)', async () => {
  let capturedScope = null;
  templates._deps = { objectiveTemplateService: { listTemplates: async (scope) => { capturedScope = scope; return [{ _id: 't1', ...scope, label: 'X' }]; } } };
  const res = await request(appAs('viewer'))
    .get('/api/institution/objective-templates')
    .set('Authorization', `Bearer ${tok('viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(String(capturedScope.institutionId), 'i1');
  assert.strictEqual(res.body.data.length, 1);
  templates._deps = null;
});

test('GET /objective-templates/:id → 404 when not found', async () => {
  templates._deps = { objectiveTemplateService: { getTemplate: async () => null } };
  const res = await request(appAs('faculty'))
    .get('/api/institution/objective-templates/missing')
    .set('Authorization', `Bearer ${tok('faculty')}`);
  assert.strictEqual(res.status, 404);
  templates._deps = null;
});

test('PUT /cohorts/:id/objective-template attaches a scoped template → 200', async () => {
  let savedCohort = null;
  templates._deps = {
    objectiveTemplateService: { getTemplate: async (scope, id) => ({ _id: id, ...scope }) },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1', objectiveTemplateId: null, save: async function () { savedCohort = this; } }) },
  };
  const res = await request(appAs('tpo_head'))
    .put('/api/institution/cohorts/c1/objective-template')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ objectiveTemplateId: 't1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(String(savedCohort.objectiveTemplateId), 't1');
  templates._deps = null;
});

test('PUT /cohorts/:id/objective-template → 404 when template not in institution', async () => {
  templates._deps = { objectiveTemplateService: { getTemplate: async () => null } };
  const res = await request(appAs('tpo_head'))
    .put('/api/institution/cohorts/c1/objective-template')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ objectiveTemplateId: 'foreign' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.code, 'TEMPLATE_NOT_FOUND');
  templates._deps = null;
});

test('viewer PUT /cohorts/:id/objective-template → 403', async () => {
  const res = await request(appAs('viewer'))
    .put('/api/institution/cohorts/c1/objective-template')
    .set('Authorization', `Bearer ${tok('viewer')}`)
    .send({ objectiveTemplateId: 't1' });
  assert.strictEqual(res.status, 403);
});
