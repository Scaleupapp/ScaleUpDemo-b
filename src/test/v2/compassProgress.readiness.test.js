// src/test/v2/compassProgress.readiness.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SVC = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const READINESS = path.resolve(__dirname, '../../services/readiness/readinessService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[SVC]; return require(SVC); }

test('explainReadiness: surfaces contributors + top draggers + distance to target', async () => {
  stub(READINESS, {
    getServedReadiness: async () => ({
      value: 70, target: 80, source: 'composite', trend: 'improving',
      breakdown: [
        { name: 'Data Structures', score: 55, weight: 8, assessed: true },
        { name: 'System Design', score: 40, weight: 6, assessed: true },
        { name: 'Communication', score: 90, weight: 3, assessed: true },
      ],
      draggers: [{ name: 'System Design', score: 40 }, { name: 'Data Structures', score: 55 }],
    }),
  });
  const svc = load();
  const out = await svc.explainReadiness('u1');
  assert.equal(out.value, 70);
  assert.equal(out.distanceToTarget, 10);
  assert.equal(out.contributors.length, 3);
  assert.equal(out.topDraggers[0].name, 'System Design');
  assert.match(out.note, /70/);
});

test('explainReadiness: degrades to topic-average note when no breakdown (legacy source)', async () => {
  stub(READINESS, {
    getServedReadiness: async () => ({ value: 62, target: 80, source: 'knowledge', trend: 'stable', breakdown: null, draggers: [{ name: 'recursion', score: 35 }] }),
  });
  const svc = load();
  const out = await svc.explainReadiness('u1');
  assert.equal(out.value, 62);
  assert.equal(out.contributors.length, 0);
  assert.equal(out.topDraggers[0].name, 'recursion');
});
