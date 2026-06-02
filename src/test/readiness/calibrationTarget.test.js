'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calibratedTarget, computeForArchetype } = require('../../services/readiness/calibrationService');

test('calibratedTarget = lowest readiness where smoothed rate crosses the threshold (interpolated, clamped 55-95)', () => {
  // midpoints 65,75,85 with rates 0.5,0.65,0.8; threshold 0.7 crosses between 75 and 85
  const curve = [{ binLo: 60, binHi: 69, n: 10, rate: 0.5 }, { binLo: 70, binHi: 79, n: 10, rate: 0.65 }, { binLo: 80, binHi: 89, n: 10, rate: 0.8 }];
  const out = calibratedTarget(curve, { threshold: 0.7 });
  assert.ok(out.target > 75 && out.target < 85, `got ${out.target}`);
  assert.equal(out.threshold, 0.7);
});
test('calibratedTarget returns null when no bin reaches the threshold', () => {
  const curve = [{ binLo: 60, binHi: 69, n: 10, rate: 0.3 }, { binLo: 70, binHi: 79, n: 10, rate: 0.5 }];
  assert.equal(calibratedTarget(curve, { threshold: 0.7 }), null);
});
test('computeForArchetype returns null below MIN_OUTCOMES_PER_ARCHETYPE', () => {
  const rows = Array.from({ length: 5 }, () => ({ readiness: 80, y: 1 }));
  assert.equal(computeForArchetype(rows, { min: 100 }), null);
});
test('computeForArchetype returns a model above MIN', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ readiness: 50 + (i % 50), y: (50 + (i % 50)) >= 78 ? 1 : 0 }));
  const m = computeForArchetype(rows, { min: 100, threshold: 0.7 });
  assert.ok(m && typeof m.target === 'number');
  assert.equal(m.reliabilityN, 120);
});
