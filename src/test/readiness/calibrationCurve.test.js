'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCurve, isotonic } = require('../../services/readiness/calibrationService');

test('isotonic pools adjacent violators into a monotonic non-decreasing sequence', () => {
  // rates 0.4, 0.8, 0.6 (violation at idx1>idx2) with equal weight -> 0.4, 0.7, 0.7
  const out = isotonic([{ rate: 0.4, n: 1 }, { rate: 0.8, n: 1 }, { rate: 0.6, n: 1 }]);
  assert.deepEqual(out.map((r) => Math.round(r * 100)), [40, 70, 70]);
});

test('buildCurve bins readiness by 10 and computes per-bin success rate (then isotonic)', () => {
  const rows = [
    { readiness: 72, y: 0 }, { readiness: 75, y: 1 }, // bin 70-79: 0.5
    { readiness: 81, y: 1 }, { readiness: 88, y: 1 }, // bin 80-89: 1.0
  ];
  const curve = buildCurve(rows, { binSize: 10 });
  const b70 = curve.find((b) => b.binLo === 70);
  const b80 = curve.find((b) => b.binLo === 80);
  assert.equal(b70.n, 2); assert.equal(b80.n, 2);
  assert.ok(b80.rate >= b70.rate); // monotonic after isotonic
});
