'use strict';

/**
 * Integration test: coding module bootstrap healthcheck.
 * Verifies that GET /api/coding/health returns 200 with expected JSON.
 */

// Stub API keys before app.js (and its transitive deps like openai.js) loads,
// so the test doesn't crash when the env vars aren't set in CI or locally.
require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub-for-tests';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../../app');

test('coding module bootstrap: exposes /api/coding/health returning 200', async () => {
  const res = await request(app).get('/api/coding/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { module: 'coding', status: 'ok' });
});
