'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('cache: get returns null until refreshed; set via _seed for tests; get returns the model', () => {
  const cache = require('../../services/readiness/calibrationCache');
  cache._seed({ interview: { target: 78, sampleCount: 120 } });
  assert.equal(cache.get('interview').target, 78);
  assert.equal(cache.get('exam'), null);
});
