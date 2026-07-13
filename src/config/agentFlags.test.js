'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { isAgentEnabled, _envKeyFor } = require('./agentFlags');

test('agentFlags: default is enabled when env var absent', () => {
  delete process.env.AGENT_COMPASS_ACTIONS_ENABLED;
  assert.strictEqual(isAgentEnabled('compass_actions'), true);
});

test('agentFlags: literal "false" disables', () => {
  process.env.AGENT_COMPASS_ACTIONS_ENABLED = 'false';
  assert.strictEqual(isAgentEnabled('compass_actions'), false);
  delete process.env.AGENT_COMPASS_ACTIONS_ENABLED;
});

test('agentFlags: any other value stays enabled', () => {
  process.env.AGENT_OPS_SENTINEL_ENABLED = 'yes';
  assert.strictEqual(isAgentEnabled('ops_sentinel'), true);
  delete process.env.AGENT_OPS_SENTINEL_ENABLED;
});

test('agentFlags: env key derivation', () => {
  assert.strictEqual(_envKeyFor('review_triage'), 'AGENT_REVIEW_TRIAGE_ENABLED');
});
