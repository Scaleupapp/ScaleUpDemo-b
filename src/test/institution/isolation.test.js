// src/test/institution/isolation.test.js
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope } = require('../../middleware/institutionScope');

const usersById = {
  uA: { _id: 'uA', institutionId: 'iA', role: 'tpo_head', status: 'active', tokenVersion: 0, scope: {} },
  uB: { _id: 'uB', institutionId: 'iB', role: 'tpo_head', status: 'active', tokenVersion: 0, scope: {} },
};
institutionAuth._loadUser = async (id) => usersById[id];

function app() {
  const a = express(); a.use(express.json());
  const db = [{ institutionId: 'iA', secret: 'A-data' }, { institutionId: 'iB', secret: 'B-data' }];
  a.get('/api/institution/data', institutionAuth, (req, res) => {
    const scope = institutionScope(req); // body.institutionId is ignored by design
    res.json({ data: db.filter(r => r.institutionId === scope.institutionId) });
  });
  return a;
}

test('institution A cannot read institution B data even when spoofing the body', async () => {
  const tokenA = signInstitutionToken({ _id: 'uA', institutionId: 'iA', role: 'tpo_head', tokenVersion: 0 });
  const res = await request(app()).get('/api/institution/data').set('Authorization', `Bearer ${tokenA}`).send({ institutionId: 'iB' });
  assert.strictEqual(res.body.data.length, 1);
  assert.strictEqual(res.body.data[0].secret, 'A-data');
});
