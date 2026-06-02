# Readiness Phase 4B — Outcome-Calibrated Model (Shadow Engine) — Design Spec

**Date:** 2026-06-02
**Status:** Approved direction (build the engine in SHADOW mode now; it stays inert until data accumulates, then auto-activates per-archetype). Backend-only.
**Repo:** `scaleup-backend` (Node/Express/Mongo).

## Goal

Build the machinery that turns accumulated `(readiness context → real outcome)` pairs into an **evidence-based target** — *"for your goal, 76% is the readiness that historically predicts success (based on N similar journeys)"* — replacing the P2 heuristic target **when, and only when, there's enough data**. Today there are **zero** outcomes (4A just shipped), so the whole engine must do nothing user-facing until a per-archetype data threshold is crossed. This mirrors exactly how the P1 composite shipped: built + tested in shadow, flipped on later.

**Why build it now with no data:** the engine, the data pipeline, the gating, and the backtest are all real, testable code (validated against synthetic data). What we *can't* do yet is trust its output — which is precisely why it's gated + flagged off. The moment outcomes exist, it's ready to fire with no further engineering.

## Scope

- **In:** training-row assembly from `ObjectiveOutcome`; the calibration-curve engine; per-archetype data-sufficiency gating; a persisted `CalibrationModel` + a recompute job; the flag-gated `getEffectiveTarget` calibrated branch (serves heuristic until data); an admin "outcome volume + calibration status per archetype" view; a synthetic backtest harness.
- **Out:** logistic regression (Stage 2 — calibration curves first, per the staged plan); the user-facing "76% historically predicts success" UI (a later task, after the flag flips); any client work.

## Decisions locked

1. **Calibration curves first** (not regression). Per archetype, bucket `readinessAtTarget` → empirical success rate → derive the target. Interpretable, robust at modest N, validatable.
2. **Shadow by default.** Compute + persist + expose in an admin view; serve calibrated targets only behind `FEATURE_OUTCOME_CALIBRATED_TARGET` AND only for archetypes past the data threshold. Until then, `getEffectiveTarget` returns today's P2 heuristic unchanged.
3. **Per-archetype gating.** `MIN_OUTCOMES_PER_ARCHETYPE` (default 100, env-tunable). An archetype below it is never calibrated; it falls back to heuristic. So calibration switches on archetype-by-archetype as each fills.
4. **Self-reported labels, censored data.** SUCCESS → 1, NOT_SUCCESS → 0, PARTIAL → 0.5 (weighted). PENDING/ABANDONED excluded (unresolved/dropped, not failures).

---

## Architecture

### Features + label (per resolved outcome)

From `ObjectiveOutcome` (4A): `archetype = setKeyFor(objectiveType)` (interview/exam/skill/generic), and `context.{readinessAtTarget, peakReadiness, wasEverReady, coverageAtCapture, weeksToOutcome}`. Label `y`: SUCCESS→1, PARTIAL→0.5, NOT_SUCCESS→0. The **primary calibration axis is `readinessAtTarget`** (fall back to `peakReadiness`, then `readinessAtCapture`, if null).

### 1. `calibrationDataService` (new) — `src/services/readiness/calibrationDataService.js`
- `assembleRows()` → reads all resolved `ObjectiveOutcome`s with a usable readiness feature, returns `[{ archetype, readiness, y, features }]` (PENDING/ABANDONED excluded). Lean, no model logic.
- `countsByArchetype()` → `{ interview: 42, exam: 7, ... }` (resolved-outcome volume) — powers the admin tracker + the build-trigger signal.

### 2. `calibrationService` (new, pure) — `src/services/readiness/calibrationService.js`
- `buildCurve(rows)` → for one archetype's rows: bin `readiness` into fixed 10-point bins (0-9,10-19,…), compute `Σy/Σn` per bin, **isotonic-smooth to monotonic-nondecreasing** (success shouldn't drop as readiness rises; pool-adjacent-violators), return `[{ binLo, binHi, n, rate }]`.
- `calibratedTarget(curve, { threshold = 0.7 })` → the lowest readiness where the smoothed success rate ≥ threshold (interpolated), clamped to the P2 band range (55–95). Returns `{ target, reliabilityN, threshold }` or `null` if the curve never reaches the threshold (insufficient signal).
- `computeForArchetype(rows, opts)` → ties it together; returns `null` when `rows.length < MIN_OUTCOMES_PER_ARCHETYPE`.
- **Pure functions** — fully unit-testable against synthetic data (no DB).

### 3. `CalibrationModel` (new) — `src/models/CalibrationModel.js`
Persisted per-archetype calibration result so reads are O(1):
```js
{ archetype: { unique }, target, reliabilityN, threshold, curve: [Mixed], sampleCount, computedAt }
```

### 4. Recompute job — `scripts/jobs/recomputeCalibration.js`
Run via the existing `run-migration` workflow (and schedulable as a weekly cron later). Steps: `assembleRows()` → group by archetype → `computeForArchetype` → upsert `CalibrationModel` (only for archetypes ≥ threshold; remove/skip others) → log `countsByArchetype` + which archetypes are now calibrated. Idempotent. `--dry-run` prints what it *would* calibrate without writing.

### 5. Integration — `targetService.getEffectiveTarget` calibrated branch
```
getEffectiveTarget(objective):
  if !FEATURE_OBJECTIVE_TARGET: return 80   // unchanged
  if FEATURE_OUTCOME_CALIBRATED_TARGET:
     m = CalibrationModel for setKeyFor(objective.objectiveType)   // cached read
     if m && m.sampleCount >= MIN && typeof m.target === 'number': return m.target   // evidence-based
  if objective.target > 0: return objective.target                 // P2 persisted
  return computeTarget(objective)                                  // P2 heuristic
```
`FEATURE_OUTCOME_CALIBRATED_TARGET` defaults OFF. With it off (today) or no `CalibrationModel`, behavior is **identical to now**. (Note: `getEffectiveTarget` is currently sync; the calibrated read makes it touch the DB — make it `async` and update its callers, OR have the recompute job stamp the calibrated target onto a cheap in-memory cache / onto the objective. **Decision: load all `CalibrationModel`s into a process-level cache refreshed every N minutes**, so `getEffectiveTarget` stays sync — see Open Items.)

### 6. Admin view — outcome volume + calibration status
Fold into the existing admin/debug surface (mirror the `_debugReadiness` pattern): `GET /api/v2/you/overview` admin block, or a small `GET /api/v1/admin/calibration` (auth: admin), returning per-archetype `{ resolvedOutcomes, threshold, calibrated: bool, target?, reliabilityN?, computedAt? }`. This is the dashboard Nirpeksh watches to know when to flip the flag (the "build trigger" from the GTM plan).

### 7. Backtest harness — `scripts/calibration/backtest.js`
Generates synthetic outcomes with a KNOWN readiness→success relationship (e.g. logistic with a true 0.7-crossing at readiness 78), runs `buildCurve` + `calibratedTarget`, and asserts the recovered target is within tolerance of the true crossing; reports calibration error + (later) AUC. Validates the MATH now; re-run on a real holdout once data exists.

---

## Data flow

```
ObjectiveOutcome (4A, accumulating) ─► calibrationDataService.assembleRows()
   ─► recomputeCalibration job (weekly) ─► calibrationService.computeForArchetype (per archetype, if ≥ threshold)
   ─► CalibrationModel (persisted) ─► process cache
   ─► getEffectiveTarget (flag-gated): calibrated target if available, else P2 heuristic
   ─► admin view shows volume + status (when to flip the flag)
```

## Shadow → activation rollout (later, not now)
1. Job runs weekly; admin view shows volume climbing.
2. When an archetype crosses the threshold, the job persists a `CalibrationModel`; admin view shows `calibrated: true` + the proposed target — **compare it to the heuristic in shadow** (does evidence agree with the guess?).
3. Sanity-check the curve + target per archetype.
4. Flip `FEATURE_OUTCOME_CALIBRATED_TARGET` → calibrated targets serve (per-archetype; others stay heuristic). Same safe, gradual cutover as the composite.
5. Later: the user-facing "based on N similar journeys" reliability copy (separate UI task).

## Edge cases
- **No data / below threshold** → `computeForArchetype` returns null; no `CalibrationModel`; `getEffectiveTarget` = heuristic. (The state today.)
- **Curve never reaches threshold** (everyone fails, or too noisy) → `calibratedTarget` null → not calibrated → heuristic.
- **Flag off** → engine still computes + persists in shadow (so we can inspect), but nothing is served.
- **All-success or all-fail bins** → isotonic smoothing + the band clamp (55–95) keep the target sane; reliabilityN exposes the thinness.
- **Archetype mapping changes** → keyed by `setKeyFor`, consistent with 4A's taxonomy.

## Testing
- `calibrationService.buildCurve` — bins + per-bin rate correct; isotonic output is monotonic.
- `calibratedTarget` — recovers the threshold crossing on a known curve; null when never reached; clamps to 55–95.
- `computeForArchetype` — null below `MIN_OUTCOMES_PER_ARCHETYPE`; sane above.
- `getEffectiveTarget` — flag off → heuristic (unchanged); flag on + sufficient model → calibrated target; flag on + no model → heuristic.
- Backtest — synthetic logistic data → recovered target within tolerance.
- Job — dry-run prints; real run upserts only sufficient archetypes; idempotent.

## Success criteria
- The engine + pipeline + job + admin view ship and are fully tested, doing **nothing user-facing** (heuristic still served).
- Backtest proves the calibration math recovers a known target on synthetic data.
- The admin view shows live outcome volume per archetype, so the team knows exactly when each archetype is ready to flip.
- Flipping `FEATURE_OUTCOME_CALIBRATED_TARGET` (later, when data exists) serves evidence-based targets with zero further engineering.

## Open items for the plan (not blockers)
- **Sync vs async `getEffectiveTarget`:** recommend a process-level `CalibrationModel` cache (refresh every ~10 min) so the function stays sync and its many callers don't all need `await`. Pin in planning after grepping callers.
- **Job scheduling:** run via `run-migration` manually at first; add a weekly cron workflow when worth it.
- **PARTIAL weighting (0.5):** revisit once real data shows whether PARTIAL behaves like success or failure; trivial to change.
- **Threshold (0.7) + MIN (100):** env-tunable; defaults documented here.
