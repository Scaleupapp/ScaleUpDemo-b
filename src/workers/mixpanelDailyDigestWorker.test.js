'use strict';

const { test } = require('node:test');
const assert = require('assert');

test('buildDigestBody formats metrics into a readable plain-text email', () => {
  const workerPath = require.resolve('./mixpanelDailyDigestWorker');
  delete require.cache[workerPath];
  const { buildDigestBody } = require('./mixpanelDailyDigestWorker');

  const metrics = {
    started: 42,
    completed: 30,
    completionRate: 71.4,
    p50LatencyMs: 3200,
    topMisses: ['System Design', 'OS Scheduling', 'Database Indexing'],
  };

  const body = buildDigestBody(metrics, '2026-05-06');

  assert.ok(body.includes('2026-05-06'), 'body should include the date');
  assert.ok(body.includes('42'), 'body should include diagnostic_started count');
  assert.ok(body.includes('30'), 'body should include diagnostic_completed count');
  assert.ok(body.includes('71.4'), 'body should include completion rate');
  assert.ok(body.includes('3200'), 'body should include p50 latency');
  assert.ok(body.includes('System Design'), 'body should include top miss #1');
  assert.ok(body.includes('OS Scheduling'), 'body should include top miss #2');
  assert.ok(body.includes('Database Indexing'), 'body should include top miss #3');

  delete require.cache[workerPath];
});
