'use strict';

/** Pool-Adjacent-Violators: returns weighted-monotonic-non-decreasing rates aligned to input order. */
function isotonic(points) {
  const blocks = points.map((p) => ({ sum: p.rate * p.n, n: p.n, count: 1 }));
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].sum / blocks[i].n > blocks[i + 1].sum / blocks[i + 1].n) {
      blocks[i].sum += blocks[i + 1].sum;
      blocks[i].n += blocks[i + 1].n;
      blocks[i].count += blocks[i + 1].count;
      blocks.splice(i + 1, 1);
      if (i > 0) i--;
    } else i++;
  }
  const out = [];
  for (const b of blocks) { const mean = b.sum / b.n; for (let k = 0; k < b.count; k++) out.push(mean); }
  return out;
}

/** rows: [{readiness:0..100, y:0|0.5|1}]. Returns [{binLo,binHi,n,rate}] (non-empty bins, isotonic-smoothed). */
function buildCurve(rows, { binSize = 10 } = {}) {
  const bins = new Map(); // binLo -> {n, sum}
  for (const r of rows) {
    if (typeof r.readiness !== 'number' || Number.isNaN(r.readiness)) continue; // NaN is typeof 'number'
    const lo = Math.min(90, Math.floor(Math.max(0, Math.min(100, r.readiness)) / binSize) * binSize);
    const b = bins.get(lo) || { n: 0, sum: 0 };
    b.n += 1; b.sum += r.y;
    bins.set(lo, b);
  }
  const ordered = [...bins.entries()].sort((a, b) => a[0] - b[0])
    .map(([lo, b]) => ({ binLo: lo, binHi: lo + binSize - 1, n: b.n, rate: b.sum / b.n }));
  const smoothed = isotonic(ordered.map((o) => ({ rate: o.rate, n: o.n })));
  return ordered.map((o, idx) => ({ ...o, rate: smoothed[idx] }));
}

module.exports = { isotonic, buildCurve };

const MIN_OUTCOMES_PER_ARCHETYPE = parseInt(process.env.CALIB_MIN_OUTCOMES || '100', 10);
const DEFAULT_THRESHOLD = parseFloat(process.env.CALIB_THRESHOLD || '0.7');
const clampBand = (n) => Math.max(55, Math.min(95, Math.round(n)));

/** Lowest readiness where the smoothed success-rate crosses `threshold`, linearly
 *  interpolated between bin midpoints, clamped to the 55-95 band. null if never reached. */
function calibratedTarget(curve, { threshold = DEFAULT_THRESHOLD } = {}) {
  if (!Array.isArray(curve) || curve.length === 0) return null;
  const pts = curve.map((b) => ({ x: (b.binLo + b.binHi) / 2, y: b.rate }));
  if (Math.max(...pts.map((p) => p.y)) < threshold) return null;
  if (pts[0].y >= threshold) return { target: clampBand(pts[0].x), threshold };
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].y >= threshold) {
      const a = pts[i - 1], b = pts[i];
      const frac = (threshold - a.y) / (b.y - a.y || 1);
      return { target: clampBand(a.x + frac * (b.x - a.x)), threshold };
    }
  }
  return null;
}

/** rows for ONE archetype → a CalibrationModel-shaped object, or null if insufficient/unreachable. */
function computeForArchetype(rows, { min = MIN_OUTCOMES_PER_ARCHETYPE, threshold = DEFAULT_THRESHOLD, binSize = 10 } = {}) {
  if (!Array.isArray(rows) || rows.length < min) return null;
  const curve = module.exports.buildCurve(rows, { binSize });
  const ct = module.exports.calibratedTarget(curve, { threshold });
  if (!ct) return null;
  return { target: ct.target, reliabilityN: rows.length, threshold, curve, sampleCount: rows.length };
}

module.exports.calibratedTarget = calibratedTarget;
module.exports.computeForArchetype = computeForArchetype;
module.exports.MIN_OUTCOMES_PER_ARCHETYPE = MIN_OUTCOMES_PER_ARCHETYPE;
module.exports.DEFAULT_THRESHOLD = DEFAULT_THRESHOLD;
