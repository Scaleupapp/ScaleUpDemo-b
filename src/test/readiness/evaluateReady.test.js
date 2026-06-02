'use strict';
require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateReady } = require('../../services/readiness/readinessService');

test('evaluateReady: composite/blend at-or-over target is ready', () => {
  assert.equal(evaluateReady({ servedSource: 'composite', servedValue: 84, target: 80 }), true);
  assert.equal(evaluateReady({ servedSource: 'blend', servedValue: 80, target: 80 }), true);
});
test('evaluateReady: legacy is never ready, even over target', () => {
  assert.equal(evaluateReady({ servedSource: 'legacy', servedValue: 95, target: 80 }), false);
  assert.equal(evaluateReady({ servedSource: 'legacy_lowconf', servedValue: 95, target: 80 }), false);
});
test('evaluateReady: under target or no target is not ready', () => {
  assert.equal(evaluateReady({ servedSource: 'composite', servedValue: 79, target: 80 }), false);
  assert.equal(evaluateReady({ servedSource: 'composite', servedValue: 90, target: null }), false);
});
