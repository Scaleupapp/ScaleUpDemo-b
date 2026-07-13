'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { buildToolset } = require('./compassOrchestrator');

const READ = [{ name: 'explain_readiness' }];
const WRITE = [{ name: 'propose_plan_update' }];

test('buildToolset: merges proposal tools when enabled', () => {
  const tools = buildToolset({ readTools: READ, proposalTools: WRITE, enabled: true });
  assert.deepStrictEqual(tools.map((t) => t.name), ['explain_readiness', 'propose_plan_update']);
});

test('buildToolset: read-only when disabled — byte-identical to today', () => {
  const tools = buildToolset({ readTools: READ, proposalTools: WRITE, enabled: false });
  assert.deepStrictEqual(tools.map((t) => t.name), ['explain_readiness']);
});
