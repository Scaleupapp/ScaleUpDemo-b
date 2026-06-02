'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('outcomeCalibratedTarget flag exists and defaults off', () => {
  delete require.cache[require.resolve('../../config/featureFlags')];
  const flags = require('../../config/featureFlags');
  assert.equal(typeof flags.outcomeCalibratedTarget, 'boolean');
  assert.equal(flags.outcomeCalibratedTarget, process.env.FEATURE_OUTCOME_CALIBRATED_TARGET === 'true');
});
