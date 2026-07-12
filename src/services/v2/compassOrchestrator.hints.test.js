'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { buildAgentHints, renderDueMisconceptionChecks } = require('./compassOrchestrator');

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

test('renderDueMisconceptionChecks: undefined → empty string', () => {
  assert.strictEqual(renderDueMisconceptionChecks(undefined), '');
});

test('renderDueMisconceptionChecks: empty array → empty string', () => {
  assert.strictEqual(renderDueMisconceptionChecks([]), '');
});

test('renderDueMisconceptionChecks: two items → both tags present, oldest first preserved, stage rendered', () => {
  const items = [
    { tag: 'off-by-one', recentTopic: 'arrays', reviewStage: 1 },
    { tag: 'null-check', recentTopic: 'pointers', reviewStage: 2 },
  ];
  const rendered = renderDueMisconceptionChecks(items);
  assert.ok(rendered.includes('off-by-one'));
  assert.ok(rendered.includes('null-check'));
  assert.ok(rendered.indexOf('off-by-one') < rendered.indexOf('null-check'));
  assert.ok(rendered.includes('stage 1/3'));
  assert.ok(rendered.includes('stage 2/3'));
});
