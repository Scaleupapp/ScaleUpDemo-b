'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { buildAgentHints } = require('./compassOrchestrator');

test('buildAgentHints: both off → empty string', () => {
  const hints = buildAgentHints({ proposalsOn: false, misconceptionsOn: false });
  assert.strictEqual(hints, '');
});

test('buildAgentHints: proposals only → propose_plan_update present, dueMisconceptionChecks absent', () => {
  const hints = buildAgentHints({ proposalsOn: true, misconceptionsOn: false });
  assert.ok(hints.includes('propose_plan_update'));
  assert.ok(!hints.includes('dueMisconceptionChecks'));
});

test('buildAgentHints: misconceptions only → dueMisconceptionChecks present, propose_plan_update absent', () => {
  const hints = buildAgentHints({ proposalsOn: false, misconceptionsOn: true });
  assert.ok(hints.includes('dueMisconceptionChecks'));
  assert.ok(!hints.includes('propose_plan_update'));
});

test('buildAgentHints: both on → both sentinels present, proposal text first', () => {
  const hints = buildAgentHints({ proposalsOn: true, misconceptionsOn: true });
  assert.ok(hints.includes('propose_plan_update'));
  assert.ok(hints.includes('dueMisconceptionChecks'));
  assert.ok(hints.indexOf('propose_plan_update') < hints.indexOf('dueMisconceptionChecks'));
});
