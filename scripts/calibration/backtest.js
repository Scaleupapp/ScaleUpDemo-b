#!/usr/bin/env node
/**
 * Synthetic backtest harness for the calibration math.
 *
 * Generates outcomes with a KNOWN readiness→success relationship (logistic
 * curve crossing `threshold` at `trueTarget`), runs the full calibration
 * pipeline, and verifies the recovered target is within tolerance.
 *
 * No DB required. Deterministic (seeded LCG, no Math.random).
 * Exit 0 on PASS, exit 1 on FAIL — CI-usable.
 *
 *   node scripts/calibration/backtest.js
 *
 * Exports { syntheticRows, recover, lcg } so the unit test can import them.
 */
'use strict';

// Require from src/ using relative path from scripts/calibration/
const { computeForArchetype, buildCurve, calibratedTarget } = require('../../src/services/readiness/calibrationService');

// ── Deterministic PRNG ────────────────────────────────────────────────────────
// Linear congruential generator (Park-Miller variant). Returns values in [0, 1).
// No Math.random() — keeps every run byte-identical regardless of Node version.
function lcg(seed) {
  let s = seed >>> 0;
  return function () {
    s = ((1103515245 * s + 12345) & 0x7fffffff) >>> 0;
    return s / 0x7fffffff;
  };
}

/**
 * Generate synthetic training rows where P(success | readiness) is a logistic
 * function crossing `threshold` at exactly `trueTarget`.
 *
 * @param {object} opts
 * @param {number} opts.n          - number of synthetic outcomes (default 4000)
 * @param {number} opts.trueTarget - readiness where P(success) === threshold (default 78)
 * @param {number} opts.threshold  - success-probability threshold (default 0.7)
 * @param {number} opts.k          - logistic steepness (default 0.15)
 * @param {number} opts.seedMul    - LCG seed (default 9301)
 * @returns {{ readiness: number, y: number }[]}
 */
function syntheticRows({ n = 4000, trueTarget = 78, threshold = 0.7, k = 0.15, seedMul = 9301 } = {}) {
  const rnd = lcg(seedMul);

  // Shift the logistic so P(success | readiness = trueTarget) === threshold exactly.
  // logistic: P = 1 / (1 + exp(-k * (x - x0)))
  // At x = trueTarget: threshold = 1 / (1 + exp(-k * (trueTarget - x0)))
  // => k * (trueTarget - x0) = log(threshold / (1 - threshold)) = logit(threshold)
  // => x0 = trueTarget - logit / k
  const logit = Math.log(threshold / (1 - threshold));
  const x0 = trueTarget - logit / k;

  const rows = [];
  for (let i = 0; i < n; i++) {
    // Uniform readiness 0..99 (integers)
    const readiness = Math.floor(rnd() * 100);
    const p = 1 / (1 + Math.exp(-k * (readiness - x0)));
    rows.push({ readiness, y: rnd() < p ? 1 : 0 });
  }
  return rows;
}

/**
 * Run the calibration pipeline on rows (all one archetype).
 * min=1 so it's not gated by the production MIN_OUTCOMES threshold.
 *
 * @param {{ readiness: number, y: number }[]} rows
 * @param {{ threshold?: number }} opts
 * @returns {number|null} recovered target, or null if curve never reaches threshold
 */
function recover(rows, { threshold = 0.7 } = {}) {
  const m = computeForArchetype(rows, { min: 1, threshold });
  return m ? m.target : null;
}

// ── Standalone runner ─────────────────────────────────────────────────────────
if (require.main === module) {
  const TRUE_TARGET = 78;
  const THRESHOLD = 0.7;
  const TOLERANCE = 5;

  const rows = syntheticRows({ n: 4000, trueTarget: TRUE_TARGET, threshold: THRESHOLD, seedMul: 9301 });
  const recovered = recover(rows, { threshold: THRESHOLD });

  console.log('[backtest] true crossing :', TRUE_TARGET);
  console.log('[backtest] recovered target:', recovered);

  if (recovered === null) {
    console.log('[backtest] FAIL — curve never reached the threshold');
    process.exit(1);
  }

  const error = Math.abs(recovered - TRUE_TARGET);
  console.log('[backtest] error          :', error.toFixed(2), `(tolerance ±${TOLERANCE})`);

  if (error <= TOLERANCE) {
    console.log('[backtest] PASS');
    process.exit(0);
  } else {
    console.log('[backtest] FAIL — error exceeds tolerance');
    process.exit(1);
  }
}

module.exports = { syntheticRows, recover, lcg };
