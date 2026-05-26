'use strict';

/**
 * Integration test: coding module bootstrap healthcheck.
 * Verifies that GET /api/coding/health returns 200 with expected JSON.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../../app');

test('coding module bootstrap: exposes /api/coding/health returning 200', async () => {
  const res = await request(app).get('/api/coding/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { module: 'coding', status: 'ok' });
});
