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

const outcomes = require('../../routes/institution/outcomes');

function tok(i, r) { return signInstitutionToken({ _id: 'u1', institutionId: i, role: r, tokenVersion: 0 }); }
function appAs(i, r) { stubLoadUser(i, r); const a = express(); a.use(express.json()); a.use('/api/institution', outcomes); return a; }

test('viewer cannot create an offer (403)', async () => {
  const res = await request(appAs('inst-A','viewer')).post('/api/institution/cohorts/c1/offers')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`).send({ studentName: 'A', companyName: 'X' });
  assert.strictEqual(res.status, 403); outcomes._deps = null;
});
test('tpo_head creates offer; scope from token, cohort from path', async () => {
  let cap = null;
  outcomes._deps = { outcomeService: { createOffer: async (scope, cohortId, body) => { cap = { scope, cohortId, body }; return { _id: 'o1', ...body }; } } };
  const res = await request(appAs('inst-A','tpo_head')).post('/api/institution/cohorts/c1/offers')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`).send({ studentName: 'A', companyName: 'Acme', ctc: 18, institutionId: 'EVIL' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(cap.scope.institutionId, 'inst-A'); assert.strictEqual(cap.cohortId, 'c1'); assert.strictEqual(cap.body.companyName, 'Acme');
  outcomes._deps = null;
});
test('GET cohort outcomes (any role)', async () => {
  outcomes._deps = { outcomeService: { cohortOutcomes: async () => ({ cohortSize: 4, placedCount: 2, placementPercent: 50, highestCtc: 30, averageCtc: 21, medianCtc: 21, companiesVisited: 3, statusCounts: {}, branchWise: [] }) } };
  const res = await request(appAs('inst-A','viewer')).get('/api/institution/cohorts/c1/outcomes')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`);
  assert.strictEqual(res.status, 200); assert.strictEqual(res.body.data.placementPercent, 50); outcomes._deps = null;
});
test('PATCH unknown offer → 404', async () => {
  outcomes._deps = { outcomeService: { updateOffer: async () => { throw new Error('OFFER_NOT_FOUND'); } } };
  const res = await request(appAs('inst-A','tpo_head')).patch('/api/institution/cohorts/c1/offers/oX')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`).send({ status: 'joined' });
  assert.strictEqual(res.status, 404); outcomes._deps = null;
});
