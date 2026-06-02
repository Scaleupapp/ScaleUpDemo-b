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
    if (typeof r.readiness !== 'number') continue;
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
