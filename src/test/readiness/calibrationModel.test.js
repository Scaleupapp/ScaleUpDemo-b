'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CalibrationModel = require('../../models/CalibrationModel');
test('CalibrationModel holds per-archetype calibration', () => {
  const m = new CalibrationModel({ archetype: 'interview', target: 78, reliabilityN: 120, threshold: 0.7,
    curve: [{ binLo: 70, binHi: 79, n: 30, rate: 0.6 }], sampleCount: 120 });
  assert.equal(m.archetype, 'interview');
  assert.equal(m.target, 78);
  assert.equal(m.curve[0].rate, 0.6);
});
