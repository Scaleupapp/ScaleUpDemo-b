# Readiness Phase 4B — Calibration Shadow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the outcome-calibration engine + data pipeline + recompute job + admin view + backtest in SHADOW mode — fully tested, doing nothing user-facing (serves today's heuristic target) until outcome data crosses a per-archetype threshold, then auto-activating behind a flag.

**Architecture:** Pure calibration math (`calibrationService`: binned success-rate curves + isotonic smoothing → an evidence-based target) is fed by `calibrationDataService` (rows from `ObjectiveOutcome`), persisted per-archetype in `CalibrationModel` by a recompute job, and read through a process-level cache so `targetService.getEffectiveTarget` stays sync. The calibrated branch is gated by `FEATURE_OUTCOME_CALIBRATED_TARGET` (default OFF) + a sample-count threshold, so today it's a pure no-op.

**Tech Stack:** Node/Express/Mongoose + `node:test`.

**Design spec:** `docs/superpowers/specs/2026-06-02-readiness-phase-4b-calibration-shadow-design.md`.
**Builds on:** 4A (`ObjectiveOutcome`, `outcomeService.setKeyFor`), P2 (`targetService.getEffectiveTarget/computeTarget`, `featureFlags`).
**Test convention:** single file = `node <path>` (NOT `node --test`). Backend cwd: `/Users/nirpekshnandan/My Products/ScaleUpDemo/scaleup-backend`.
**Hard rule:** behavior with the flag OFF (today) must be byte-identical to current `getEffectiveTarget`.

---

## File Structure
- Create `src/models/CalibrationModel.js` — persisted per-archetype calibration result.
- Create `src/services/readiness/calibrationService.js` — pure: `buildCurve`, `isotonic`, `calibratedTarget`, `computeForArchetype`.
- Create `src/services/readiness/calibrationDataService.js` — `assembleRows`, `countsByArchetype`.
- Create `src/services/readiness/calibrationCache.js` — process-level cache of `CalibrationModel`s (keeps `getEffectiveTarget` sync).
- Modify `src/config/featureFlags.js` — add `FEATURE_OUTCOME_CALIBRATED_TARGET`.
- Modify `src/services/readiness/targetService.js` — calibrated branch in `getEffectiveTarget`.
- Create `scripts/jobs/recomputeCalibration.js` — recompute job (`--dry-run`).
- Create `scripts/calibration/backtest.js` — synthetic backtest harness.
- Modify `src/routes/admin.js` — calibration status/volume view.
- Tests under `src/test/readiness/`.

---

### Task 1: Feature flag

**Files:** Modify `src/config/featureFlags.js`; Test `src/test/readiness/calibrationFlag.test.js`

- [ ] **Step 1: Write the failing test**
```js
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
```
- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/calibrationFlag.test.js`
- [ ] **Step 3: Implement** — in `src/config/featureFlags.js` add to the `FLAGS` object (next to `FEATURE_OBJECTIVE_TARGET`): `FEATURE_OUTCOME_CALIBRATED_TARGET: process.env.FEATURE_OUTCOME_CALIBRATED_TARGET === 'true',` and to the `module.exports` (next to `objectiveTarget`): `outcomeCalibratedTarget: FLAGS.FEATURE_OUTCOME_CALIBRATED_TARGET,`
- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git add src/config/featureFlags.js src/test/readiness/calibrationFlag.test.js && git commit -m "feat(readiness): FEATURE_OUTCOME_CALIBRATED_TARGET flag (Phase 4B)"`

---

### Task 2: `CalibrationModel`

**Files:** Create `src/models/CalibrationModel.js`; Test `src/test/readiness/calibrationModel.test.js`

- [ ] **Step 1: Write the failing test**
```js
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
```
- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement** `src/models/CalibrationModel.js`
```js
'use strict';
const mongoose = require('mongoose');
const CalibrationModelSchema = new mongoose.Schema(
  {
    archetype: { type: String, required: true, unique: true, index: true }, // interview|exam|skill|generic
    target: { type: Number },          // evidence-based target (null if curve never reaches threshold)
    reliabilityN: { type: Number },    // samples behind it
    threshold: { type: Number },       // success-prob threshold used (e.g. 0.7)
    curve: { type: [mongoose.Schema.Types.Mixed] }, // [{binLo,binHi,n,rate}] smoothed
    sampleCount: { type: Number },
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
module.exports = mongoose.model('CalibrationModel', CalibrationModelSchema);
```
- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git add src/models/CalibrationModel.js src/test/readiness/calibrationModel.test.js && git commit -m "feat(readiness): CalibrationModel (Phase 4B)"`

---

### Task 3: `calibrationService.buildCurve` + `isotonic`

**Files:** Create `src/services/readiness/calibrationService.js`; Test `src/test/readiness/calibrationCurve.test.js`

- [ ] **Step 1: Write the failing test**
```js
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
```
- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/calibrationCurve.test.js`
- [ ] **Step 3: Implement** `src/services/readiness/calibrationService.js`
```js
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
```
- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git add src/services/readiness/calibrationService.js src/test/readiness/calibrationCurve.test.js && git commit -m "feat(readiness): calibration curve + isotonic (Phase 4B)"`

---

### Task 4: `calibratedTarget` + `computeForArchetype`

**Files:** Modify `src/services/readiness/calibrationService.js`; Test `src/test/readiness/calibrationTarget.test.js`

- [ ] **Step 1: Write the failing test**
```js
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
```
- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/calibrationTarget.test.js`
- [ ] **Step 3: Implement** — append to `calibrationService.js` (and extend exports):
```js
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
```
- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git add src/services/readiness/calibrationService.js src/test/readiness/calibrationTarget.test.js && git commit -m "feat(readiness): calibratedTarget + computeForArchetype (Phase 4B)"`

---

### Task 5: `calibrationDataService`

**Files:** Create `src/services/readiness/calibrationDataService.js`; Test `src/test/readiness/calibrationData.test.js`

- [ ] **Step 1: Write the failing test**
```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('assembleRows: resolved outcomes → {archetype,readiness,y}; PENDING/ABANDONED excluded; y mapping', async () => {
  const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
  const svc = require('../../services/readiness/calibrationDataService');
  const docs = [
    { objectiveType: 'interview_preparation', label: 'SUCCESS', context: { readinessAtTarget: 82 } },
    { objectiveType: 'interview_preparation', label: 'NOT_SUCCESS', context: { readinessAtTarget: 60 } },
    { objectiveType: 'upskilling', label: 'PARTIAL', context: { readinessAtTarget: 70 } },
    { objectiveType: 'interview_preparation', label: 'PENDING', context: { readinessAtTarget: 50 } }, // excluded
  ];
  const orig = ObjectiveOutcome.find;
  ObjectiveOutcome.find = () => ({ lean: async () => docs });
  try {
    const rows = await svc.assembleRows();
    assert.equal(rows.length, 3); // PENDING excluded
    const iv = rows.find((r) => r.readiness === 82);
    assert.equal(iv.archetype, 'interview'); assert.equal(iv.y, 1);
    assert.equal(rows.find((r) => r.readiness === 60).y, 0);
    assert.equal(rows.find((r) => r.readiness === 70).y, 0.5); // PARTIAL
    const counts = await svc.countsByArchetype();
    assert.equal(counts.interview, 2);
  } finally { ObjectiveOutcome.find = orig; }
});
```
- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/calibrationData.test.js`
- [ ] **Step 3: Implement** `src/services/readiness/calibrationDataService.js`
```js
'use strict';
const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
const { setKeyFor } = require('./outcomeService');

const Y = { SUCCESS: 1, PARTIAL: 0.5, NOT_SUCCESS: 0 };

/** Resolved, terminal-label outcomes with a usable readiness feature → training rows.
 *  PENDING/ABANDONED excluded (unresolved / dropped, not measurable outcomes). */
async function assembleRows() {
  const docs = await ObjectiveOutcome
    .find({ label: { $in: ['SUCCESS', 'PARTIAL', 'NOT_SUCCESS'] } })
    .lean();
  const rows = [];
  for (const d of docs) {
    const c = d.context || {};
    const readiness = [c.readinessAtTarget, c.peakReadiness, c.readinessAtCapture].find((v) => typeof v === 'number');
    if (readiness == null) continue;
    rows.push({
      archetype: setKeyFor(d.objectiveType),
      readiness,
      y: Y[d.label],
      features: { wasEverReady: !!c.wasEverReady, coverage: c.coverageAtCapture ?? null, weeksToOutcome: c.weeksToOutcome ?? null },
    });
  }
  return rows;
}

async function countsByArchetype() {
  const rows = await assembleRows();
  return rows.reduce((m, r) => { m[r.archetype] = (m[r.archetype] || 0) + 1; return m; }, {});
}

module.exports = { assembleRows, countsByArchetype };
```
- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git add src/services/readiness/calibrationDataService.js src/test/readiness/calibrationData.test.js && git commit -m "feat(readiness): calibration training-row assembly (Phase 4B)"`

---

### Task 6: `calibrationCache` (process-level, keeps getEffectiveTarget sync)

**Files:** Create `src/services/readiness/calibrationCache.js`; Test `src/test/readiness/calibrationCache.test.js`

- [ ] **Step 1: Write the failing test**
```js
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
```
- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/calibrationCache.test.js`
- [ ] **Step 3: Implement** `src/services/readiness/calibrationCache.js`
```js
'use strict';
// Process-level cache of CalibrationModels keyed by archetype, so the sync
// getEffectiveTarget can read calibration without an await. Refreshed lazily
// (TTL) and after the recompute job.
const TTL_MS = parseInt(process.env.CALIB_CACHE_TTL_MS || String(10 * 60 * 1000), 10);
let _byArchetype = {};
let _loadedAt = 0;

async function refresh() {
  try {
    const CalibrationModel = require('../../models/CalibrationModel');
    const docs = await CalibrationModel.find({}).lean();
    _byArchetype = docs.reduce((m, d) => { m[d.archetype] = d; return m; }, {});
    _loadedAt = Date.now();
  } catch (e) { /* leave stale cache on error */ }
}

function get(archetype) {
  // Best-effort lazy refresh; never blocks (fire-and-forget when stale).
  if (Date.now() - _loadedAt > TTL_MS) { _loadedAt = Date.now(); refresh().catch(() => {}); }
  return _byArchetype[archetype] || null;
}

function _seed(map) { _byArchetype = map; _loadedAt = Date.now(); } // tests only

module.exports = { refresh, get, _seed };
```
- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git add src/services/readiness/calibrationCache.js src/test/readiness/calibrationCache.test.js && git commit -m "feat(readiness): process-level calibration cache (Phase 4B)"`

---

### Task 7: `getEffectiveTarget` calibrated branch

**Files:** Modify `src/services/readiness/targetService.js`; Test `src/test/readiness/getEffectiveTargetCalibrated.test.js`

- [ ] **Step 1: Write the failing test**
```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('getEffectiveTarget: flag OFF -> heuristic unchanged; flag ON + cached model -> calibrated; flag ON + no model -> heuristic', () => {
  const cache = require('../../services/readiness/calibrationCache');
  const targetService = require('../../services/readiness/targetService');
  const obj = { objectiveType: 'interview_preparation', target: 82, specifics: {} };

  // flag controlled via the live featureFlags require — emulate by stubbing the flags module
  const flags = require('../../config/featureFlags');
  const origObjFlag = flags.objectiveTarget, origCalFlag = flags.outcomeCalibratedTarget;
  Object.defineProperty(flags, 'objectiveTarget', { value: true, configurable: true });

  // flag OFF -> persisted heuristic target (82)
  Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: false, configurable: true });
  assert.equal(targetService.getEffectiveTarget(obj), 82);

  // flag ON + cached calibrated model (target 78, sufficient) -> 78
  Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: true, configurable: true });
  cache._seed({ interview: { target: 78, sampleCount: 150 } });
  assert.equal(targetService.getEffectiveTarget(obj), 78);

  // flag ON + no model for this archetype -> heuristic (82)
  cache._seed({});
  assert.equal(targetService.getEffectiveTarget(obj), 82);

  Object.defineProperty(flags, 'objectiveTarget', { value: origObjFlag, configurable: true });
  Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: origCalFlag, configurable: true });
});
```
- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/getEffectiveTargetCalibrated.test.js`
- [ ] **Step 3: Implement** — in `src/services/readiness/targetService.js`, modify `getEffectiveTarget`. Current (P2):
```js
function getEffectiveTarget(objective) {
  if (!featureFlags.objectiveTarget) return LEGACY_TARGET;
  if (objective && typeof objective.target === 'number' && objective.target > 0) return objective.target;
  return computeTarget(objective);
}
```
Replace with (insert the calibrated branch BEFORE the persisted/heuristic fallback):
```js
function getEffectiveTarget(objective) {
  if (!featureFlags.objectiveTarget) return LEGACY_TARGET;
  // Phase 4B — evidence-based target when calibration is on AND the archetype has
  // a sufficient model. Read via a sync process cache. No-op when flag off / no model.
  if (featureFlags.outcomeCalibratedTarget && objective) {
    try {
      const { setKeyFor } = require('./outcomeService');
      const m = require('./calibrationCache').get(setKeyFor(objective.objectiveType));
      if (m && typeof m.target === 'number' && (m.sampleCount || 0) > 0) return m.target;
    } catch (e) { /* fall through to heuristic */ }
  }
  if (objective && typeof objective.target === 'number' && objective.target > 0) return objective.target;
  return computeTarget(objective);
}
```
- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/getEffectiveTargetCalibrated.test.js`
- [ ] **Step 5: Run the existing target tests to confirm no regression** — `node src/test/readiness/targetService.test.js` (expect `# fail 0`).
- [ ] **Step 6: Commit** — `git add src/services/readiness/targetService.js src/test/readiness/getEffectiveTargetCalibrated.test.js && git commit -m "feat(readiness): calibrated getEffectiveTarget branch, flag-gated (Phase 4B)"`

---

### Task 8: Recompute job

**Files:** Create `scripts/jobs/recomputeCalibration.js`

- [ ] **Step 1: Implement** (no unit test — it's an orchestration script over already-tested units; verified by `--dry-run`):
```js
#!/usr/bin/env node
/**
 * Recompute per-archetype calibration from accumulated outcomes. Run weekly via
 * the Run-DB-Migration workflow (or cron later). Idempotent. --dry-run prints
 * what it would calibrate without writing.
 *   node scripts/jobs/recomputeCalibration.js [--dry-run]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const DRY = process.argv.includes('--dry-run');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);
  const dataSvc = require('../../src/services/readiness/calibrationDataService');
  const calib = require('../../src/services/readiness/calibrationService');
  const CalibrationModel = require('../../src/models/CalibrationModel');

  const rows = await dataSvc.assembleRows();
  const byArch = rows.reduce((m, r) => { (m[r.archetype] = m[r.archetype] || []).push(r); return m; }, {});
  const summary = {};
  for (const [arch, archRows] of Object.entries(byArch)) {
    const model = calib.computeForArchetype(archRows);
    summary[arch] = { samples: archRows.length, calibrated: !!model, target: model?.target ?? null };
    if (model && !DRY) {
      await CalibrationModel.updateOne(
        { archetype: arch },
        { $set: { ...model, archetype: arch, computedAt: new Date() } },
        { upsert: true }
      );
    }
  }
  console.log(`[calibration] ${DRY ? 'DRY-RUN ' : ''}min=${calib.MIN_OUTCOMES_PER_ARCHETYPE} threshold=${calib.DEFAULT_THRESHOLD}`);
  console.log('[calibration] result:', JSON.stringify(summary, null, 2));
  await mongoose.disconnect();
}
if (require.main === module) { main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }); }
```
- [ ] **Step 2: Verify parse** — `node --check scripts/jobs/recomputeCalibration.js`
- [ ] **Step 3: Commit** — `git add scripts/jobs/recomputeCalibration.js && git commit -m "feat(readiness): calibration recompute job (Phase 4B)"`

---

### Task 9: Backtest harness

**Files:** Create `scripts/calibration/backtest.js`; Test `src/test/readiness/calibrationBacktest.test.js`

- [ ] **Step 1: Write the failing test** (the synthetic generator + recovery is the part worth asserting):
```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syntheticRows, recover } = require('../../scripts/calibration/backtest');

test('backtest recovers a known target from synthetic logistic data within tolerance', () => {
  const rows = syntheticRows({ n: 4000, trueTarget: 78, threshold: 0.7, seedMul: 9301 });
  const recovered = recover(rows, { threshold: 0.7 });
  assert.ok(Math.abs(recovered - 78) <= 6, `recovered ${recovered}, expected ~78`);
});
```
- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/calibrationBacktest.test.js`
- [ ] **Step 3: Implement** `scripts/calibration/backtest.js`
```js
'use strict';
const { computeForArchetype } = require('../../src/services/readiness/calibrationService');

// Deterministic PRNG (no Math.random — keeps tests reproducible).
function lcg(seed) { let s = seed >>> 0; return () => (s = (1103515245 * s + 12345) & 0x7fffffff) / 0x7fffffff; }

/** Synthetic outcomes where P(success|readiness) is logistic crossing `threshold` at `trueTarget`. */
function syntheticRows({ n = 4000, trueTarget = 78, threshold = 0.7, k = 0.15, seedMul = 9301 } = {}) {
  const rnd = lcg(seedMul);
  const logit = Math.log(threshold / (1 - threshold)); // value of k*(x-x0) at the crossing
  const x0 = trueTarget - logit / k; // shift so P(success)=threshold exactly at trueTarget
  const rows = [];
  for (let i = 0; i < n; i++) {
    const readiness = Math.floor(rnd() * 100);
    const p = 1 / (1 + Math.exp(-k * (readiness - x0)));
    rows.push({ readiness, y: rnd() < p ? 1 : 0 });
  }
  return rows;
}

function recover(rows, { threshold = 0.7 } = {}) {
  const m = computeForArchetype(rows, { min: 1, threshold });
  return m ? m.target : null;
}

if (require.main === module) {
  const rows = syntheticRows({});
  console.log('[backtest] recovered target:', recover(rows, {}), '(true ~78)');
}
module.exports = { syntheticRows, recover, lcg };
```
- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/calibrationBacktest.test.js` (tune `k`/`n` only if tolerance is tight; the relationship must be recoverable).
- [ ] **Step 5: Commit** — `git add scripts/calibration/backtest.js src/test/readiness/calibrationBacktest.test.js && git commit -m "feat(readiness): calibration backtest harness (Phase 4B)"`

---

### Task 10: Admin calibration view

**Files:** Modify `src/routes/admin.js`

- [ ] **Step 1: Add a route** (uses the existing admin auth in that file — match how other routes in `admin.js` are guarded; grep `adminAuth`/`auth` at the top of the file and mirror it):
```js
// Phase 4B — calibration status + outcome volume per archetype (the "when to flip the flag" dashboard).
router.get('/calibration', /* existing admin auth middleware on this router */ async (req, res) => {
  try {
    const counts = await require('../services/readiness/calibrationDataService').countsByArchetype();
    const models = await require('../models/CalibrationModel').find({}).lean();
    const byArch = models.reduce((m, d) => { m[d.archetype] = d; return m; }, {});
    const calib = require('../services/readiness/calibrationService');
    const archetypes = ['interview', 'exam', 'skill', 'generic'];
    const out = archetypes.map((a) => ({
      archetype: a,
      resolvedOutcomes: counts[a] || 0,
      threshold: calib.MIN_OUTCOMES_PER_ARCHETYPE,
      calibrated: !!byArch[a],
      target: byArch[a]?.target ?? null,
      reliabilityN: byArch[a]?.reliabilityN ?? null,
      computedAt: byArch[a]?.computedAt ?? null,
    }));
    res.json({ success: true, data: { flagOn: require('../config/featureFlags').outcomeCalibratedTarget, archetypes: out } });
  } catch (err) {
    console.error('[admin/calibration]', err.message);
    res.status(500).json({ success: false, message: 'Could not load calibration status.' });
  }
});
```
(Open the file, find the router's admin-auth pattern, and apply the SAME guard to this route as the others. Do not invent a new auth mechanism.)
- [ ] **Step 2: Verify parse** — `node --check src/routes/admin.js`
- [ ] **Step 3: Commit** — `git add src/routes/admin.js && git commit -m "feat(readiness): admin calibration status view (Phase 4B)"`

---

### Task 11: Run suite + push

- [ ] **Step 1:** `for f in src/test/readiness/calibration*.test.js src/test/readiness/getEffectiveTargetCalibrated.test.js src/test/readiness/targetService.test.js; do echo "## $f"; node "$f" 2>&1 | grep -E "# (tests|pass|fail)"; done` — all `# fail 0`.
- [ ] **Step 2:** `node --check scripts/jobs/recomputeCalibration.js && node --check scripts/calibration/backtest.js && node --check src/routes/admin.js && node --check src/services/readiness/targetService.js && echo OK`
- [ ] **Step 3: Confirm no-op today** — run a dry-run to prove the engine produces nothing with no data: `node scripts/jobs/recomputeCalibration.js --dry-run 2>&1 | tail -5` (expect empty/no-calibrated-archetypes summary; this needs MONGODB_URI so it'll run on the server via the migration workflow — locally just confirm it parses).
- [ ] **Step 4:** `git push origin master`

---

## Self-Review (by plan author)

**Spec coverage:** flag → T1; CalibrationModel → T2; buildCurve+isotonic → T3; calibratedTarget+computeForArchetype (threshold, clamp 55-95, MIN gate) → T4; assembleRows+countsByArchetype (PENDING/ABANDONED excluded, y mapping) → T5; sync process cache → T6; flag-gated getEffectiveTarget (no-op when off/no model) → T7; recompute job (--dry-run, idempotent upsert) → T8; synthetic backtest → T9; admin volume/status view → T10. Shadow/inert-until-data → enforced by T4's MIN gate + T7's flag + T11 Step 3.

**Type consistency:** `setKeyFor` (4A outcomeService) used by T5 + T7. `computeForArchetype` returns `{target, reliabilityN, threshold, curve, sampleCount}` (T4) → consumed by T8 upsert + T10 view + matches `CalibrationModel` (T2). `calibrationCache.get(archetype)` (T6) returns the model → used by T7. Consistent.

**Flagged planning decisions (explicit):** (a) T10's admin-auth guard must mirror the existing pattern in `admin.js` (grep it — do NOT invent auth). (b) The recompute job runs via the `Run-DB-Migration` workflow initially (`node scripts/jobs/recomputeCalibration.js`); a weekly cron is a later add. (c) `getEffectiveTarget` stays sync via the TTL cache; the cache self-refreshes lazily — acceptable staleness for a slowly-changing model.

**Hard-rule check (no-op today):** flag defaults off (T1) → T7's calibrated branch is skipped → `getEffectiveTarget` is byte-identical to P2. Existing `targetService.test.js` must stay green (T7 Step 5). ✓

**Out of scope:** logistic regression (Stage 2), user-facing "based on N journeys" UI, client work.
