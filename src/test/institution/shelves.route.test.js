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

const shelves = require('../../routes/institution/shelves');

function tok(i, r) { return signInstitutionToken({ _id: 'u1', institutionId: i, role: r, tokenVersion: 0 }); }
function appAs(i, r) { stubLoadUser(i, r); const a = express(); a.use(express.json()); a.use('/api/institution', shelves); return a; }

test('viewer cannot create a shelf (403)', async () => {
  const res = await request(appAs('inst-A','viewer')).post('/api/institution/cohorts/c1/shelves')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`).send({ title: 'DSA' });
  assert.strictEqual(res.status, 403); shelves._deps = null;
});
test('tpo_head creates shelf; scope from token, cohort from path', async () => {
  let cap = null;
  shelves._deps = { shelfService: { createShelf: async (scope, cohortId, body) => { cap = { scope, cohortId, body }; return { _id: 's1', ...body }; } } };
  const res = await request(appAs('inst-A','tpo_head')).post('/api/institution/cohorts/c1/shelves')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`).send({ title: 'DSA', institutionId: 'EVIL' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(cap.scope.institutionId, 'inst-A'); assert.strictEqual(cap.cohortId, 'c1'); assert.strictEqual(cap.body.title, 'DSA');
  shelves._deps = null;
});
test('GET shelves any role', async () => {
  shelves._deps = { shelfService: { listShelves: async () => ([{ _id: 's1', title: 'DSA', items: [] }]) } };
  const res = await request(appAs('inst-A','viewer')).get('/api/institution/cohorts/c1/shelves')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`);
  assert.strictEqual(res.status, 200); assert.strictEqual(res.body.data[0].title, 'DSA'); shelves._deps = null;
});
test('add item to unknown shelf → 404', async () => {
  shelves._deps = { shelfService: { addItem: async () => { throw new Error('SHELF_NOT_FOUND'); } } };
  const res = await request(appAs('inst-A','tpo_coordinator')).post('/api/institution/cohorts/c1/shelves/sX/items')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_coordinator')}`).send({ type: 'link', title: 'x', url: 'https://y' });
  assert.strictEqual(res.status, 404); shelves._deps = null;
});
test('DELETE item ok', async () => {
  let called = null;
  shelves._deps = { shelfService: { deleteItem: async (scope, cohortId, shelfId, itemId) => { called = { scope, cohortId, shelfId, itemId }; return { _id: itemId }; } } };
  const res = await request(appAs('inst-A','tpo_head')).delete('/api/institution/cohorts/c1/shelves/s1/items/i1')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`);
  assert.strictEqual(res.status, 200); assert.strictEqual(called.shelfId, 's1'); assert.strictEqual(called.itemId, 'i1'); shelves._deps = null;
});
