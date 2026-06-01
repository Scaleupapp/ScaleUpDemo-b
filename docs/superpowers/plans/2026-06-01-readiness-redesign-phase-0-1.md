# Readiness Redesign — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers / next chat session:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (inline) or `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **To resume after a context reset, read the "RESUME STATE" section first** — it tells you exactly which task is next.

**Goal:** Replace the shallow, gameable "readiness = average quiz score" with (Phase 0) a single persisted source of truth that is *behavior-identical today*, then (Phase 1) a credible, multi-primitive, objective-weighted **composite** readiness engine computed in **shadow mode** alongside the old number — so nothing the user sees changes until we deliberately cut over.

**Architecture:** All new code lives under `src/services/readiness/`. Phase 0 introduces `readinessService.assembleLegacy()` (returns exactly today's number) + a `ReadinessSnapshot` persistence record, and routes `/api/v2/you/overview` through it. Phase 1 adds `primitiveMap` (competency→primitive routing, derived from the EXISTING `objective.analysis.competencies[].assessmentTypes` — no LLM re-analysis needed), `competencyMasteryService` (per-competency mastery from the right primitive, with recency decay + confidence), and `readinessService.computeComposite()` (Σ weight×mastery + bounded behavioral modifier). The composite is computed best-effort and stored in `snapshot.shadow`; it is only *served* when the `FEATURE_COMPOSITE_READINESS` flag is on.

**Tech stack:** Node/Express, Mongoose, `node:test` runner (run a single file with `node --test --test-force-exit <path>`), BullMQ (not needed here). No new dependencies.

**Hard safety rules (do not violate):**
1. **Additive only.** No schema changes to `QuizAttempt`, `CapstoneSession`, `DrillAttempt`, `InterviewSession`, `ContentProgress`, `CompetitionProfile`, `MetaSkillMastery`, `KnowledgeProfile`, `Plan`, `Journey`. We only READ them.
2. **Behavior-preserving until cutover.** Phase 0 must return the byte-identical readiness value the overview returns today. Phase 1 composite is shadow-only (logged + stored) unless the flag is on.
3. **Never throw into the hot path.** All new reads are wrapped in try/catch; on any failure the overview falls back to the legacy value. The readiness ring must never break.
4. **One source of truth.** After Phase 0, the readiness number is computed in exactly one place (`readinessService`). Do not re-introduce inline formulas.

---

## RESUME STATE (update this as you go)

**Current status:** NOT STARTED — begin at Task 1.

**Phase 0 — Source of truth + history (BACKEND, target: this morning)**
- [ ] Task 1: `ReadinessSnapshot` model + test
- [ ] Task 2: `readinessService.assembleLegacy()` (behavior-identical) + test
- [ ] Task 3: Wire `/you/overview` through `readinessService` + persist snapshot (no value change)
- [ ] Task 4: `readinessService.persistSnapshot()` best-effort + test

**Phase 1 — Composite engine in shadow mode (BACKEND, target: this afternoon)**
- [ ] Task 5: `primitiveMap.assessmentTypesToPrimitive()` + test
- [ ] Task 6: signal aggregators (`buildCodingSignal`, `buildInterviewSignal`, `buildBehavioralSignal`) + test
- [ ] Task 7: `recencyFactor()` + `confidenceFrom()` helpers + test
- [ ] Task 8: `competencyMasteryService.computeCompetencyMastery()` + test
- [ ] Task 9: `readinessService.computeComposite()` (weighted rollup + bounded modifier) + test
- [ ] Task 10: `FEATURE_COMPOSITE_READINESS` flag
- [ ] Task 11: Wire composite into `/you/overview` shadow mode (store in `snapshot.shadow`, serve only if flag on)

**Phase 1b — "What's in your number" UI (FRONTEND, iOS + Android, stretch / may slip past EOD)**
- [ ] Task 12: `/you/overview` returns `readiness.breakdown` when composite served
- [ ] Task 13: iOS readiness-breakdown sheet
- [ ] Task 14: Android readiness-breakdown sheet

**HOW TO RESUME:** Find the first unchecked task above. Read that task's section. Run its test command to confirm prior state. Continue. After each task: run the test, then `git add` + `git commit` with the message in the task. Then check the box here and commit the updated plan.

---

## Roadmap context (where this fits — not in scope for THIS plan)

This plan is Phases 0–1 of a 4-phase readiness redesign agreed with the founder:
- **Phase 0** (this plan): one source of truth + history.
- **Phase 1** (this plan): multi-primitive composite engine, shadow mode (Robust Rule B below).
- **Phase 2** (future plan): objective-aware, ambition-anchored target + re-targeting (Robust Rule A below) — replaces the hardcoded `80` in `you.js:584`, `trajectoryService.js:21`, `planService.js`.
- **Phase 3** (future plan): the "Ready" moment + Proof-of-Readiness artifact + 3-path "what's next".
- **Phase 4** (future): outcome-calibrated model.

The two robust rules below are the design contract; Phase 1 implements Rule B. Rule A is documented here so Phase 2 inherits it.

### Robust Rule A — Objective → Target & Re-target (Phase 2; documented for continuity)
- Capture explicit ambition (exam score/percentile | company tier | depth).
- Extend `objectiveAnalysisService` analysis to emit per-competency `targetProficiencyLevel`+`targetScore` calibrated to the ambition.
- `objective.target = Σ(competency.weight × competency.targetScore) / Σ(weight)` (replaces flat 80; fallback 80 if absent).
- Re-target only on ambition change / hit-and-stretch / objective-edit; recalibration moves the *plan path*, not the goalposts; keep `targetHistory`.

### Robust Rule B — Multi-primitive readiness, weighted by objective (Phase 1; THIS plan)
Two-level weighting, both derived from the EXISTING competency framework:
- **Level 1 (competency→primitive)**, from `competency.assessmentTypes`:
  - `knowledge_recall`, `exam_style` → **quiz** (KnowledgeProfile.topicMastery)
  - `applied_scenario`, `framework_application` → **coding** if objective is coding-eligible, else **interview**
  - `situational_judgment`, `case_study` → **interview** (InterviewSession.evaluation.overallScore)
  - content / notes / competitions → **behavioral/momentum only** (bounded modifier + confidence, NOT skill mastery)
- **Level 2 (per-competency mastery)** from mapped primitive, adjusted by **recency decay**, **difficulty weight** (coding), and **confidence** (evidence volume × recency × difficulty).
- **Composite** = `Σ(weight × mastery) / Σ(weight)`, plus bounded behavioral modifier (±5), clamped 0–100.

---

## File structure (Phase 0 + Phase 1)

```
src/services/readiness/
  readinessService.js          # NEW — the single source of truth. assembleLegacy(), persistSnapshot(), computeComposite()
  primitiveMap.js              # NEW — pure: assessmentTypes → 'quiz'|'coding'|'interview'
  competencyMasteryService.js  # NEW — per-competency mastery + signal aggregators + recency/confidence helpers
src/models/
  ReadinessSnapshot.js         # NEW — persisted readiness history (value + breakdown + shadow composite)
src/config/
  featureFlags.js              # MODIFY — add FEATURE_COMPOSITE_READINESS
src/routes/v2/
  you.js                       # MODIFY (overview handler ~L57-100) — route through readinessService; persist snapshot; shadow composite
src/test/readiness/
  readinessService.test.js         # NEW
  primitiveMap.test.js             # NEW
  competencyMasteryService.test.js # NEW
  readinessComposite.test.js       # NEW
```

**Responsibility split:** `primitiveMap` is pure routing. `competencyMasteryService` owns per-competency scoring + the DB signal aggregators + recency/confidence math. `readinessService` orchestrates (legacy assembly, composite rollup, snapshot persistence). `you.js` only fetches docs and calls `readinessService` — no math in the route.

---

# PHASE 0

### Task 1: `ReadinessSnapshot` model

**Files:**
- Create: `src/models/ReadinessSnapshot.js`
- Test: `src/test/readiness/readinessService.test.js` (model-shape assertions live with the service tests)

- [ ] **Step 1: Create the model**

```javascript
// src/models/ReadinessSnapshot.js
'use strict';

const mongoose = require('mongoose');

/**
 * One persisted readiness reading. Written best-effort whenever the overview
 * computes readiness, so we can (a) show history/trajectory and (b) compare the
 * shadow composite against the served legacy value during Phase 1 rollout.
 *
 * `value` is what was SERVED to the user. `shadow` holds the parallel composite
 * (Phase 1) so we can diff old-vs-new without changing what the user sees.
 */
const ReadinessSnapshotSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', index: true },
    value: { type: Number, required: true, min: 0, max: 100 },
    source: { type: String }, // 'plan' | 'journey' | 'knowledge' | 'floor' | 'composite'
    breakdown: { type: mongoose.Schema.Types.Mixed }, // optional served breakdown
    // Parallel composite reading (Phase 1 shadow). Null until composite runs.
    shadow: {
      value: { type: Number },
      confidence: { type: Number },
      breakdown: { type: mongoose.Schema.Types.Mixed },
      delta: { type: Number }, // shadow.value - value, for quick scans
    },
  },
  { timestamps: true }
);

ReadinessSnapshotSchema.index({ userId: 1, objectiveId: 1, createdAt: -1 });

module.exports = mongoose.model('ReadinessSnapshot', ReadinessSnapshotSchema);
```

- [ ] **Step 2: Sanity-check it loads (no DB needed)**

Run: `node -e "require('./src/models/ReadinessSnapshot'); console.log('ok')"`
Expected: prints `ok` (mongoose may warn about no connection — that's fine).

- [ ] **Step 3: Commit**

```bash
git add src/models/ReadinessSnapshot.js
git commit -m "feat(readiness): add ReadinessSnapshot model (history + shadow composite)"
```

---

### Task 2: `readinessService.assembleLegacy()` — behavior-identical

This MUST reproduce exactly what `you.js` overview does today (waterfall + the coding blend already shipped in build 180):
`base = plan?.readinessScore ?? journey?.readinessScore ?? computeReadinessFromKnowledge(knowledge) ?? 0`, then blend coding mastery with the bounded ramp (weight 0→0.10 over 5→10 attempts), clamped 0–100.

**Files:**
- Create: `src/services/readiness/readinessService.js`
- Test: `src/test/readiness/readinessService.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/test/readiness/readinessService.test.js
'use strict';
require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assembleLegacy, computeReadinessFromKnowledge } = require('../../services/readiness/readinessService');

test('assembleLegacy: plan.readinessScore wins the waterfall', () => {
  const r = assembleLegacy({ plan: { readinessScore: 62 }, journey: { readinessScore: 40 }, knowledge: { overallScore: 30 } });
  assert.strictEqual(r.value, 62);
  assert.strictEqual(r.source, 'plan');
});

test('assembleLegacy: falls through to journey then knowledge then floor', () => {
  assert.strictEqual(assembleLegacy({ journey: { readinessScore: 41 } }).value, 41);
  assert.strictEqual(assembleLegacy({ knowledge: { overallScore: 33 } }).value, 33);
  assert.strictEqual(assembleLegacy({}).value, 0);
});

test('assembleLegacy: coding blend is bounded and ramps in only after 5 attempts', () => {
  // base 60, coding value 80, weight 0.10 (>=10 attempts) -> 60*0.9 + 80*0.1 = 62
  const blended = assembleLegacy({ knowledge: { overallScore: 60 }, codingComponent: { value: 80, weight: 0.10, attempt_count: 12 } });
  assert.strictEqual(blended.value, 62);
  // weight 0 -> unchanged
  const none = assembleLegacy({ knowledge: { overallScore: 60 }, codingComponent: { value: 80, weight: 0, attempt_count: 3 } });
  assert.strictEqual(none.value, 60);
});

test('computeReadinessFromKnowledge mirrors the overview helper', () => {
  assert.strictEqual(computeReadinessFromKnowledge({ overallScore: 47 }), 47);
  assert.strictEqual(computeReadinessFromKnowledge(null), null);
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `node --test --test-force-exit src/test/readiness/readinessService.test.js`
Expected: FAIL — `Cannot find module '../../services/readiness/readinessService'`.

- [ ] **Step 3: Implement `readinessService.assembleLegacy` + `computeReadinessFromKnowledge`**

```javascript
// src/services/readiness/readinessService.js
'use strict';

/**
 * Single source of truth for the readiness number. Phase 0: assembleLegacy
 * reproduces the existing overview computation EXACTLY (waterfall + bounded
 * coding blend). Phase 1 adds computeComposite (shadow). All callers
 * (you.js overview, Compass coach context) should route through here.
 */

/** Mirror of the overview's knowledge fallback (do not change semantics). */
function computeReadinessFromKnowledge(knowledge) {
  if (!knowledge) return null;
  if (typeof knowledge.overallScore === 'number' && knowledge.overallScore > 0) {
    return Math.round(knowledge.overallScore);
  }
  if (Array.isArray(knowledge.topicMastery) && knowledge.topicMastery.length > 0) {
    const sum = knowledge.topicMastery.reduce((s, t) => s + (t.score || 0), 0);
    return Math.round(sum / knowledge.topicMastery.length);
  }
  if (knowledge.topicProfiles) {
    const entries = Object.values(knowledge.topicProfiles);
    if (entries.length > 0) {
      const avg = entries.reduce((s, t) => s + (t.masteryLevel || 0), 0) / entries.length;
      return Math.round(avg);
    }
  }
  return null;
}

/**
 * Reproduce today's served readiness, byte-for-byte.
 * @param {{ plan?, journey?, knowledge?, codingComponent?: {value:number,weight:number,attempt_count:number} }} inputs
 * @returns {{ value:number, source:string, coding: object|null }}
 */
function assembleLegacy({ plan, journey, knowledge, codingComponent } = {}) {
  let value;
  let source;
  if (plan && typeof plan.readinessScore === 'number') { value = plan.readinessScore; source = 'plan'; }
  else if (journey && typeof journey.readinessScore === 'number') { value = journey.readinessScore; source = 'journey'; }
  else {
    const k = computeReadinessFromKnowledge(knowledge);
    if (typeof k === 'number') { value = k; source = 'knowledge'; }
    else { value = 0; source = 'floor'; }
  }

  let coding = null;
  if (codingComponent && codingComponent.weight > 0 && value > 0) {
    const w = codingComponent.weight;
    value = Math.max(0, Math.min(100, Math.round(value * (1 - w) + codingComponent.value * w)));
    coding = {
      value: Math.round(codingComponent.value),
      weight: Number(w.toFixed(3)),
      attempt_count: codingComponent.attempt_count,
    };
  }
  return { value, source, coding };
}

module.exports = { assembleLegacy, computeReadinessFromKnowledge };
```

- [ ] **Step 4: Run the test, verify it PASSES**

Run: `node --test --test-force-exit src/test/readiness/readinessService.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/readiness/readinessService.js src/test/readiness/readinessService.test.js
git commit -m "feat(readiness): readinessService.assembleLegacy (behavior-identical source of truth)"
```

---

### Task 3: Route `/you/overview` through `readinessService` (no value change)

**Files:**
- Modify: `src/routes/v2/you.js` (overview handler — the readiness block currently at ~L57-95, plus the `coding` field on the response)

- [ ] **Step 1: Replace the inline readiness + coding-blend block**

In the `/overview` handler, the current code computes `baseReadiness`, then a try/catch coding blend producing `readiness` + `codingComponent`. Replace that whole block (from `const baseReadiness = ...` through the coding try/catch that sets `readiness`/`codingComponent`) with:

```javascript
    // Readiness — single source of truth (readinessService). Behavior-identical
    // to the previous inline computation; coding blend now lives in the service.
    const readinessService = require('../../coding/../services/readiness/readinessService');
    let codingComponent = null;
    try {
      const elig = evaluateCodingEligibility(objective);
      if (elig.eligible) {
        codingComponent = await readinessUpdater.getMetaSkillComponent({ user_id: userId, role_track: elig.role_track });
      }
    } catch (e) {
      console.warn('[v2/you/overview] coding component fetch skipped:', e.message);
    }
    const legacy = readinessService.assembleLegacy({ plan, journey, knowledge, codingComponent });
    const readiness = legacy.value;
    const codingForResponse = legacy.coding; // {value,weight,attempt_count} | null
```

> NOTE: keep the existing `require` path correct — use `require('../../services/readiness/readinessService')` (adjust to the real relative depth from `src/routes/v2/you.js`, which is `../../services/readiness/readinessService`). Remove the stray `coding/../` in the snippet above.

- [ ] **Step 2: Update the response's `readiness.coding` field**

Where the response builds `readiness: { score: readiness, ..., coding: codingComponent }`, change `coding: codingComponent` to `coding: codingForResponse`.

- [ ] **Step 3: Verify the file parses**

Run: `node --check src/routes/v2/you.js`
Expected: no output (exit 0).

- [ ] **Step 4: Run the existing you-overview tests if present, else smoke-require**

Run: `node --test --test-force-exit src/test/coding/youCodingMastery.test.js`
Expected: PASS (this exercises the you router load path; the overview-specific path is covered manually).

- [ ] **Step 5: Commit**

```bash
git add src/routes/v2/you.js
git commit -m "refactor(readiness): route /you/overview through readinessService (no value change)"
```

---

### Task 4: `readinessService.persistSnapshot()` (best-effort history)

**Files:**
- Modify: `src/services/readiness/readinessService.js`
- Modify: `src/routes/v2/you.js` (call persistSnapshot after computing readiness)
- Test: `src/test/readiness/readinessService.test.js` (append)

- [ ] **Step 1: Append the failing test**

```javascript
test('persistSnapshot writes a ReadinessSnapshot and never throws', async () => {
  const ReadinessSnapshot = require('../../models/ReadinessSnapshot');
  const created = [];
  const orig = ReadinessSnapshot.create;
  ReadinessSnapshot.create = async (doc) => { created.push(doc); return doc; };
  const svc = require('../../services/readiness/readinessService');
  await svc.persistSnapshot({ userId: 'u1', objectiveId: 'o1', value: 62, source: 'knowledge' });
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].value, 62);
  // never throws even if create blows up
  ReadinessSnapshot.create = async () => { throw new Error('db down'); };
  await svc.persistSnapshot({ userId: 'u1', value: 50, source: 'floor' }); // should resolve, not reject
  ReadinessSnapshot.create = orig;
});
```

- [ ] **Step 2: Run, verify FAIL** (`persistSnapshot is not a function`).

Run: `node --test --test-force-exit src/test/readiness/readinessService.test.js`

- [ ] **Step 3: Implement persistSnapshot**

Add to `readinessService.js` and export it:

```javascript
const ReadinessSnapshot = require('../../models/ReadinessSnapshot');

/**
 * Best-effort persist. NEVER throws — readiness history must not gate the
 * overview response.
 * @param {{userId, objectiveId?, value, source, breakdown?, shadow?}} snap
 */
async function persistSnapshot(snap) {
  try {
    await ReadinessSnapshot.create({
      userId: snap.userId,
      objectiveId: snap.objectiveId,
      value: snap.value,
      source: snap.source,
      breakdown: snap.breakdown,
      shadow: snap.shadow,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[readinessService.persistSnapshot] skipped:', err.message);
  }
}

module.exports = { assembleLegacy, computeReadinessFromKnowledge, persistSnapshot };
```

- [ ] **Step 4: Run, verify PASS.**

Run: `node --test --test-force-exit src/test/readiness/readinessService.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Call it from the overview (non-blocking)**

In `you.js` overview, after `const readiness = legacy.value;` add:

```javascript
    void readinessService.persistSnapshot({
      userId, objectiveId: objective?._id, value: readiness, source: legacy.source,
    });
```

- [ ] **Step 6: `node --check src/routes/v2/you.js` (exit 0), then commit**

```bash
git add src/services/readiness/readinessService.js src/test/readiness/readinessService.test.js src/routes/v2/you.js
git commit -m "feat(readiness): persist ReadinessSnapshot on overview (best-effort history)"
```

**END OF PHASE 0.** At this point the user-facing number is unchanged, but it flows through one service and is recorded with history. Update RESUME STATE checkboxes and commit the plan.

---

# PHASE 1 — Composite engine (shadow mode)

### Task 5: `primitiveMap.assessmentTypesToPrimitive()`

**Files:**
- Create: `src/services/readiness/primitiveMap.js`
- Test: `src/test/readiness/primitiveMap.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/test/readiness/primitiveMap.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessmentTypesToPrimitive } = require('../../services/readiness/primitiveMap');

test('knowledge/exam types -> quiz', () => {
  assert.strictEqual(assessmentTypesToPrimitive(['knowledge_recall'], { coding: false }), 'quiz');
  assert.strictEqual(assessmentTypesToPrimitive(['exam_style'], { coding: false }), 'quiz');
});
test('applied/framework -> coding when coding-eligible, else interview', () => {
  assert.strictEqual(assessmentTypesToPrimitive(['applied_scenario'], { coding: true }), 'coding');
  assert.strictEqual(assessmentTypesToPrimitive(['framework_application'], { coding: false }), 'interview');
});
test('situational/case -> interview', () => {
  assert.strictEqual(assessmentTypesToPrimitive(['situational_judgment'], { coding: true }), 'interview');
  assert.strictEqual(assessmentTypesToPrimitive(['case_study'], { coding: false }), 'interview');
});
test('empty/unknown -> quiz (safe default)', () => {
  assert.strictEqual(assessmentTypesToPrimitive([], { coding: false }), 'quiz');
  assert.strictEqual(assessmentTypesToPrimitive(['nonsense'], { coding: true }), 'quiz');
});
test('mixed types pick the highest-signal primitive (interview > coding > quiz)', () => {
  assert.strictEqual(assessmentTypesToPrimitive(['knowledge_recall', 'case_study'], { coding: true }), 'interview');
  assert.strictEqual(assessmentTypesToPrimitive(['knowledge_recall', 'applied_scenario'], { coding: true }), 'coding');
});
```

- [ ] **Step 2: Run, verify FAIL.**

Run: `node --test --test-force-exit src/test/readiness/primitiveMap.test.js`

- [ ] **Step 3: Implement**

```javascript
// src/services/readiness/primitiveMap.js
'use strict';

/**
 * Route a competency to the primitive that best MEASURES it, from the
 * competency's assessmentTypes (already produced by objectiveAnalysisService).
 * Priority when mixed: interview > coding > quiz (higher-signal wins).
 *
 * @param {string[]} assessmentTypes
 * @param {{coding:boolean}} ctx  — coding=true if the objective is coding-eligible
 * @returns {'quiz'|'coding'|'interview'}
 */
function assessmentTypesToPrimitive(assessmentTypes, ctx = { coding: false }) {
  const types = Array.isArray(assessmentTypes) ? assessmentTypes : [];
  const wantsInterview = types.some((t) => t === 'situational_judgment' || t === 'case_study');
  const wantsApplied = types.some((t) => t === 'applied_scenario' || t === 'framework_application');
  if (wantsInterview) return 'interview';
  if (wantsApplied) return ctx.coding ? 'coding' : 'interview';
  // knowledge_recall / exam_style / unknown / empty -> quiz
  return 'quiz';
}

module.exports = { assessmentTypesToPrimitive };
```

- [ ] **Step 4: Run, verify PASS.** `node --test --test-force-exit src/test/readiness/primitiveMap.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/services/readiness/primitiveMap.js src/test/readiness/primitiveMap.test.js
git commit -m "feat(readiness): primitiveMap — competency assessmentTypes -> primitive"
```

---

### Task 6: Signal aggregators (`buildCodingSignal`, `buildInterviewSignal`, `buildBehavioralSignal`)

These turn raw per-user docs into compact signal objects the mastery service consumes. They take **already-fetched arrays/docs** (so they're pure + testable); the DB fetch happens in the orchestrator.

**Files:**
- Create: `src/services/readiness/competencyMasteryService.js`
- Test: `src/test/readiness/competencyMasteryService.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/test/readiness/competencyMasteryService.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../../services/readiness/competencyMasteryService');

const NOW = new Date('2026-06-01T00:00:00Z');

test('buildCodingSignal aggregates capstones + drills + mastery axes', () => {
  const sig = svc.buildCodingSignal({
    capstones: [{ result: { overall_score: 80 }, graded_at: new Date('2026-05-30T00:00:00Z') }],
    drills: [{ grade: { overall_score: 70 }, submitted_at: new Date('2026-05-29T00:00:00Z') }],
    mastery: { axes: { prompting: 60, verification: 70, decomposition: 50, refactoring: 40 } },
    now: NOW,
  });
  assert.ok(sig.score >= 0 && sig.score <= 100);
  assert.strictEqual(sig.count, 2);          // 1 capstone + 1 drill
  assert.ok(sig.lastAt instanceof Date);
});

test('buildInterviewSignal averages recent interview scores', () => {
  const sig = svc.buildInterviewSignal({
    interviews: [
      { evaluation: { overallScore: 60 }, completedAt: new Date('2026-05-20T00:00:00Z') },
      { evaluation: { overallScore: 80 }, completedAt: new Date('2026-05-31T00:00:00Z') },
    ],
    now: NOW,
  });
  assert.strictEqual(sig.count, 2);
  assert.ok(sig.score >= 60 && sig.score <= 80);
});

test('buildBehavioralSignal returns a bounded modifier in [-5, 5]', () => {
  const hot = svc.buildBehavioralSignal({ streak: 30, contentCompleted: 20, activeDays7: 7 });
  const cold = svc.buildBehavioralSignal({ streak: 0, contentCompleted: 0, activeDays7: 0 });
  assert.ok(hot.modifier <= 5 && hot.modifier >= -5);
  assert.ok(cold.modifier <= 5 && cold.modifier >= -5);
  assert.ok(hot.modifier >= cold.modifier);
});
```

- [ ] **Step 2: Run, verify FAIL.** `node --test --test-force-exit src/test/readiness/competencyMasteryService.test.js`

- [ ] **Step 3: Implement the aggregators (file start)**

```javascript
// src/services/readiness/competencyMasteryService.js
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Coding signal: blend recent capstone/drill scores with mastery-axis average. */
function buildCodingSignal({ capstones = [], drills = [], mastery = null, now = new Date() }) {
  const events = [
    ...capstones.map((c) => ({ score: c.result?.overall_score, at: c.graded_at, weightK: 1.5 })), // capstones weigh more
    ...drills.map((d) => ({ score: d.grade?.overall_score, at: d.submitted_at, weightK: 1.0 })),
  ].filter((e) => typeof e.score === 'number');

  const count = events.length;
  let score = 0;
  let lastAt = null;
  if (count > 0) {
    let wSum = 0, sSum = 0;
    for (const e of events) {
      const w = e.weightK;
      wSum += w; sSum += e.score * w;
      if (!lastAt || new Date(e.at) > lastAt) lastAt = new Date(e.at);
    }
    score = sSum / wSum;
  } else if (mastery?.axes) {
    const a = mastery.axes;
    score = ((a.prompting || 0) + (a.verification || 0) + (a.decomposition || 0) + (a.refactoring || 0)) / 4;
  }
  return { score: Math.round(score), count, lastAt, hasDifficulty: count > 0 };
}

/** Interview signal: recency-weighted average of evaluation.overallScore. */
function buildInterviewSignal({ interviews = [], now = new Date() }) {
  const events = interviews
    .map((i) => ({ score: i.evaluation?.overallScore, at: i.completedAt }))
    .filter((e) => typeof e.score === 'number');
  const count = events.length;
  let score = 0, lastAt = null;
  if (count > 0) {
    let wSum = 0, sSum = 0;
    for (const e of events) {
      const ageDays = Math.max(0, (now - new Date(e.at)) / DAY_MS);
      const w = Math.max(0.3, 1 - ageDays / 120); // linear recency weight, floor 0.3
      wSum += w; sSum += e.score * w;
      if (!lastAt || new Date(e.at) > lastAt) lastAt = new Date(e.at);
    }
    score = sSum / wSum;
  }
  return { score: Math.round(score), count, lastAt };
}

/** Behavioral momentum -> a small bounded modifier in [-5, +5]. Not skill. */
function buildBehavioralSignal({ streak = 0, contentCompleted = 0, activeDays7 = 0 } = {}) {
  // Normalize each to 0..1, average, map to [-5, +5] centered so "average" ~ 0.
  const s = Math.min(1, streak / 30);          // 30-day streak = full
  const c = Math.min(1, contentCompleted / 20); // 20 lessons = full
  const a = Math.min(1, activeDays7 / 7);       // 7/7 active days = full
  const composite = (s + c + a) / 3;            // 0..1
  const modifier = Math.round((composite - 0.5) * 10); // -5..+5
  return { modifier: Math.max(-5, Math.min(5, modifier)), composite };
}

module.exports = { buildCodingSignal, buildInterviewSignal, buildBehavioralSignal };
```

- [ ] **Step 4: Run, verify PASS.** `node --test --test-force-exit src/test/readiness/competencyMasteryService.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/services/readiness/competencyMasteryService.js src/test/readiness/competencyMasteryService.test.js
git commit -m "feat(readiness): signal aggregators for coding/interview/behavioral"
```

---

### Task 7: `recencyFactor()` + `confidenceFrom()` helpers

**Files:**
- Modify: `src/services/readiness/competencyMasteryService.js`
- Test: `src/test/readiness/competencyMasteryService.test.js` (append)

- [ ] **Step 1: Append failing test**

```javascript
test('recencyFactor decays from 1.0 toward a 0.5 floor over 90 days', () => {
  assert.strictEqual(svc.recencyFactor(NOW, NOW), 1);
  const d45 = svc.recencyFactor(new Date(NOW.getTime() - 45 * 24 * 3600 * 1000), NOW);
  assert.ok(d45 > 0.5 && d45 < 1);
  const d200 = svc.recencyFactor(new Date(NOW.getTime() - 200 * 24 * 3600 * 1000), NOW);
  assert.strictEqual(d200, 0.5);
  assert.strictEqual(svc.recencyFactor(null, NOW), 0.5); // unknown date -> floor
});

test('confidenceFrom rises with evidence count + recency + difficulty', () => {
  const low = svc.confidenceFrom({ count: 0, recency: 0.5, hasDifficulty: false });
  const high = svc.confidenceFrom({ count: 5, recency: 1, hasDifficulty: true });
  assert.ok(low >= 0 && low <= 1);
  assert.ok(high > low);
  assert.ok(high <= 1);
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement + export**

```javascript
/** 1.0 at now, decays linearly to a 0.5 floor by 90 days. null -> floor. */
function recencyFactor(lastAt, now = new Date()) {
  if (!lastAt) return 0.5;
  const ageDays = Math.max(0, (now - new Date(lastAt)) / DAY_MS);
  return Math.max(0.5, 1 - 0.5 * (ageDays / 90));
}

/** Evidence confidence in [0,1] from count, recency factor, and difficulty. */
function confidenceFrom({ count = 0, recency = 0.5, hasDifficulty = false }) {
  const volume = Math.min(1, count / 4);            // 4+ assessments = full volume confidence
  const diff = hasDifficulty ? 1 : 0.7;             // difficulty-graded evidence is more trustworthy
  const c = volume * recency * diff;
  return Math.max(0, Math.min(1, Number(c.toFixed(3))));
}
```
Add `recencyFactor, confidenceFrom` to `module.exports`.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/readiness/competencyMasteryService.js src/test/readiness/competencyMasteryService.test.js
git commit -m "feat(readiness): recencyFactor + confidenceFrom helpers"
```

---

### Task 8: `computeCompetencyMastery()`

**Files:**
- Modify: `src/services/readiness/competencyMasteryService.js`
- Test: `src/test/readiness/competencyMasteryService.test.js` (append)

- [ ] **Step 1: Append failing test**

```javascript
test('computeCompetencyMastery: quiz competency reads topicMastery by name', () => {
  const knowledge = { topicMastery: [{ topic: 'data structures', score: 72, lastAssessedAt: NOW, quizzesTaken: 3 }] };
  const out = svc.computeCompetencyMastery({
    competency: { name: 'Data Structures', assessmentTypes: ['knowledge_recall'] },
    ctx: { coding: true }, knowledge, codingSignal: null, interviewSignal: null, now: NOW,
  });
  assert.strictEqual(out.primitive, 'quiz');
  assert.ok(Math.abs(out.score - 72) <= 1); // recency factor = 1 at NOW
  assert.ok(out.confidence > 0);
});

test('computeCompetencyMastery: applied competency in coding objective uses codingSignal', () => {
  const out = svc.computeCompetencyMastery({
    competency: { name: 'API Design', assessmentTypes: ['applied_scenario'] },
    ctx: { coding: true }, knowledge: { topicMastery: [] },
    codingSignal: { score: 85, count: 2, lastAt: NOW, hasDifficulty: true }, interviewSignal: null, now: NOW,
  });
  assert.strictEqual(out.primitive, 'coding');
  assert.ok(out.score >= 80);
});

test('computeCompetencyMastery: no evidence -> score 0, confidence 0', () => {
  const out = svc.computeCompetencyMastery({
    competency: { name: 'Nothing', assessmentTypes: ['knowledge_recall'] },
    ctx: { coding: false }, knowledge: { topicMastery: [] }, codingSignal: null, interviewSignal: null, now: NOW,
  });
  assert.strictEqual(out.score, 0);
  assert.strictEqual(out.confidence, 0);
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement**

```javascript
const { assessmentTypesToPrimitive } = require('./primitiveMap');

/** Fuzzy topic match (same spirit as objectiveAnalysisService): name-overlap. */
function matchTopicMastery(name, topicMastery = []) {
  const key = String(name || '').toLowerCase();
  let best = null;
  for (const t of topicMastery) {
    const topic = String(t.topic || '').toLowerCase();
    if (topic === key || topic.includes(key) || key.includes(topic)) {
      if (!best || (t.score || 0) > (best.score || 0)) best = t;
    }
  }
  return best;
}

/**
 * Per-competency mastery from its mapped primitive.
 * @returns {{score:number, confidence:number, primitive:string}}
 */
function computeCompetencyMastery({ competency, ctx, knowledge, codingSignal, interviewSignal, now = new Date() }) {
  const primitive = assessmentTypesToPrimitive(competency.assessmentTypes, ctx);

  if (primitive === 'coding' && codingSignal && codingSignal.count > 0) {
    const rec = recencyFactor(codingSignal.lastAt, now);
    return {
      primitive,
      score: Math.round(codingSignal.score * rec),
      confidence: confidenceFrom({ count: codingSignal.count, recency: rec, hasDifficulty: codingSignal.hasDifficulty }),
    };
  }
  if (primitive === 'interview' && interviewSignal && interviewSignal.count > 0) {
    const rec = recencyFactor(interviewSignal.lastAt, now);
    return {
      primitive,
      score: Math.round(interviewSignal.score * rec),
      confidence: confidenceFrom({ count: interviewSignal.count, recency: rec, hasDifficulty: false }),
    };
  }
  // quiz (default) OR a non-quiz primitive with no evidence yet -> fall back to topicMastery
  const tm = matchTopicMastery(competency.name, knowledge?.topicMastery);
  if (tm && typeof tm.score === 'number') {
    const rec = recencyFactor(tm.lastAssessedAt, now);
    return {
      primitive: 'quiz',
      score: Math.round(tm.score * rec),
      confidence: confidenceFrom({ count: tm.quizzesTaken || 1, recency: rec, hasDifficulty: false }),
    };
  }
  return { primitive, score: 0, confidence: 0 };
}
```
Add `computeCompetencyMastery, matchTopicMastery` to `module.exports`.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/readiness/competencyMasteryService.js src/test/readiness/competencyMasteryService.test.js
git commit -m "feat(readiness): computeCompetencyMastery (per-competency, mapped primitive + recency)"
```

---

### Task 9: `readinessService.computeComposite()`

**Files:**
- Modify: `src/services/readiness/readinessService.js`
- Test: `src/test/readiness/readinessComposite.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// src/test/readiness/readinessComposite.test.js
'use strict';
require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeComposite } = require('../../services/readiness/readinessService');

const NOW = new Date('2026-06-01T00:00:00Z');

test('computeComposite weights competency mastery by competency.weight', () => {
  const objective = { objectiveType: 'upskilling', specifics: {}, analysis: { competencies: [
    { name: 'Data Structures', weight: 8, assessmentTypes: ['knowledge_recall'] },
    { name: 'Communication', weight: 2, assessmentTypes: ['situational_judgment'] },
  ] } };
  const knowledge = { topicMastery: [{ topic: 'data structures', score: 90, lastAssessedAt: NOW, quizzesTaken: 4 }] };
  const interviewSignal = { score: 40, count: 2, lastAt: NOW };
  const r = computeComposite({ objective, ctx: { coding: false }, knowledge, codingSignal: null, interviewSignal, behavioral: { modifier: 0 }, now: NOW });
  // weighted = (90*8 + 40*2)/10 = 80 ; +0 modifier
  assert.strictEqual(r.value, 80);
  assert.strictEqual(r.breakdown.length, 2);
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
});

test('computeComposite applies the bounded behavioral modifier and clamps 0..100', () => {
  const objective = { objectiveType: 'upskilling', specifics: {}, analysis: { competencies: [
    { name: 'X', weight: 5, assessmentTypes: ['knowledge_recall'] },
  ] } };
  const knowledge = { topicMastery: [{ topic: 'x', score: 98, lastAssessedAt: NOW, quizzesTaken: 4 }] };
  const r = computeComposite({ objective, ctx: { coding: false }, knowledge, codingSignal: null, interviewSignal: null, behavioral: { modifier: 5 }, now: NOW });
  assert.strictEqual(r.value, 100); // 98 + 5 -> clamp 100
});

test('computeComposite returns null when objective has no analysis', () => {
  const r = computeComposite({ objective: { analysis: null }, ctx: { coding: false }, knowledge: {}, now: NOW });
  assert.strictEqual(r, null);
});
```

- [ ] **Step 2: Run, verify FAIL.** `node --test --test-force-exit src/test/readiness/readinessComposite.test.js`

- [ ] **Step 3: Implement in readinessService.js**

```javascript
const competencyMastery = require('./competencyMasteryService');

/**
 * Multi-primitive, objective-weighted composite readiness (Robust Rule B).
 * Pure: takes already-fetched signals. Returns null if the objective has no
 * competency framework (so callers fall back to legacy).
 * @returns {{value:number, confidence:number, behavioralModifier:number, breakdown:Array}|null}
 */
function computeComposite({ objective, ctx, knowledge, codingSignal, interviewSignal, behavioral, now = new Date() }) {
  const comps = objective?.analysis?.competencies;
  if (!Array.isArray(comps) || comps.length === 0) return null;

  let wSum = 0, sSum = 0, cSum = 0;
  const breakdown = [];
  for (const comp of comps) {
    const w = typeof comp.weight === 'number' && comp.weight > 0 ? comp.weight : 5;
    const m = competencyMastery.computeCompetencyMastery({
      competency: comp, ctx: ctx || { coding: false }, knowledge, codingSignal, interviewSignal, now,
    });
    wSum += w; sSum += m.score * w; cSum += m.confidence * w;
    breakdown.push({ competency: comp.name, weight: w, primitive: m.primitive, score: m.score, confidence: m.confidence });
  }
  if (wSum === 0) return null;
  const weighted = sSum / wSum;
  const modifier = behavioral?.modifier || 0;
  const value = Math.max(0, Math.min(100, Math.round(weighted + modifier)));
  const confidence = Number((cSum / wSum).toFixed(3));
  return { value, confidence, behavioralModifier: modifier, breakdown };
}

module.exports = { assembleLegacy, computeReadinessFromKnowledge, persistSnapshot, computeComposite };
```

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/readiness/readinessService.js src/test/readiness/readinessComposite.test.js
git commit -m "feat(readiness): computeComposite — objective-weighted multi-primitive rollup"
```

---

### Task 10: `FEATURE_COMPOSITE_READINESS` flag

**Files:**
- Modify: `src/config/featureFlags.js`

- [ ] **Step 1: Add the flag** (match the existing pattern in the file)

```javascript
// inside FLAGS:
  FEATURE_COMPOSITE_READINESS: process.env.FEATURE_COMPOSITE_READINESS === 'true',
// inside the exported map:
  compositeReadiness: FLAGS.FEATURE_COMPOSITE_READINESS,
```

- [ ] **Step 2: Verify** `node -e "console.log(require('./src/config/featureFlags').compositeReadiness)"` → prints `false` (flag off by default = shadow mode).

- [ ] **Step 3: Commit**

```bash
git add src/config/featureFlags.js
git commit -m "feat(readiness): FEATURE_COMPOSITE_READINESS flag (default off = shadow)"
```

---

### Task 11: Wire composite into `/you/overview` (shadow mode)

**Files:**
- Modify: `src/routes/v2/you.js` overview handler

- [ ] **Step 1: After computing `legacy`, fetch signals + compute the shadow composite (best-effort)**

Add inside the overview handler, after `const readiness = legacy.value;` (and before building the response). The DB fetches mirror the patterns already used elsewhere in `you.js` (see the `/you/analytics` coding block for the exact model access):

```javascript
    // Phase 1 SHADOW: compute the composite alongside legacy. Best-effort; on any
    // failure we keep serving `legacy`. Stored in the snapshot for old-vs-new diffing.
    let shadow = null;
    try {
      if (objective?.analysis?.competencies?.length) {
        const flags = require('../../config/featureFlags');
        const readinessSvc = require('../../services/readiness/readinessService');
        const cms = require('../../services/readiness/competencyMasteryService');
        const elig = evaluateCodingEligibility(objective);
        const now = new Date();

        const CapstoneSession = mongoose.model('CapstoneSession');
        const DrillAttempt = mongoose.model('DrillAttempt');
        const MetaSkillMastery = mongoose.model('MetaSkillMastery');
        const InterviewSessionM = mongoose.model('InterviewSession');

        const [capstones, drills, mastery, interviews] = await Promise.all([
          elig.eligible ? CapstoneSession.find({ user_id: userId, status: 'graded' }).select('result.overall_score graded_at').sort({ graded_at: -1 }).limit(10).lean() : [],
          elig.eligible ? DrillAttempt.find({ user_id: userId, status: 'graded' }).select('grade.overall_score submitted_at').sort({ submitted_at: -1 }).limit(20).lean() : [],
          elig.eligible ? MetaSkillMastery.findOne({ user_id: userId, role_track: elig.role_track }).lean() : null,
          InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] } }).select('evaluation.overallScore completedAt').sort({ completedAt: -1 }).limit(10).lean(),
        ]);

        const codingSignal = elig.eligible ? cms.buildCodingSignal({ capstones, drills, mastery, now }) : null;
        const interviewSignal = cms.buildInterviewSignal({ interviews, now });
        const behavioral = cms.buildBehavioralSignal({
          streak: competition?.currentStreak || 0,
          contentCompleted: 0, // optional: wire ContentProgress count later; 0 is safe
          activeDays7: 0,
        });

        const composite = readinessSvc.computeComposite({
          objective, ctx: { coding: !!elig.eligible }, knowledge, codingSignal, interviewSignal, behavioral, now,
        });
        if (composite) {
          shadow = { value: composite.value, confidence: composite.confidence, breakdown: composite.breakdown, delta: composite.value - readiness };
          console.log(`[readiness-shadow] user=${userId} legacy=${readiness} composite=${composite.value} delta=${shadow.delta} conf=${composite.confidence}`);
        }
      }
    } catch (e) {
      console.warn('[v2/you/overview] shadow composite skipped:', e.message);
    }
```

> NOTE: `InterviewSession` is already imported at the top of `you.js` (used by `/analytics`). Reuse that import — remove the `InterviewSessionM = mongoose.model(...)` line if the top-level import is in scope; it's shown for completeness.

- [ ] **Step 2: Persist the shadow on the snapshot** — update the existing `persistSnapshot` call from Task 4:

```javascript
    void readinessService.persistSnapshot({
      userId, objectiveId: objective?._id, value: readiness, source: legacy.source, shadow,
    });
```

- [ ] **Step 3: Serve the composite ONLY when the flag is on** — immediately after `shadow` is computed:

```javascript
    let servedReadiness = readiness;
    if (shadow && require('../../config/featureFlags').compositeReadiness) {
      servedReadiness = shadow.value;
    }
```
Then use `servedReadiness` (not `readiness`) in the `readiness.score` response field and in `computeOnTrackText`.

- [ ] **Step 4: Verify parse** `node --check src/routes/v2/you.js` (exit 0).

- [ ] **Step 5: Run the you router smoke test** `node --test --test-force-exit src/test/coding/youCodingMastery.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/v2/you.js
git commit -m "feat(readiness): shadow composite in /you/overview (served only behind flag)"
```

**END OF PHASE 1 (backend).** The composite now runs for every overview load, is logged + persisted for old-vs-new comparison, and is served only when `FEATURE_COMPOSITE_READINESS=true`. Update RESUME STATE and commit the plan. Watch the `[readiness-shadow]` logs / snapshots for a few days, tune weights, then flip the flag.

---

# PHASE 1b — "What's in your number" UI (frontend, stretch)

> Only start after Phase 1 backend is green and the flag has been validated. Two platforms (iOS + Android). This is the part most likely to slip past EOD — that's acceptable; the backend is the high-value core.

### Task 12: Return `breakdown` from overview when composite is served
- Modify `you.js`: when `servedReadiness === shadow.value`, add `readiness.breakdown = shadow.breakdown` and `readiness.confidence = shadow.confidence` to the response.
- Commit: `feat(readiness): expose composite breakdown on overview when served`.

### Task 13 (iOS): readiness breakdown sheet
- In the V2 Home readiness ring, add a tappable "Why this number" affordance opening a sheet that lists `breakdown` (competency · primitive · score · weight) + overall confidence + top-2 lowest-score-highest-weight gaps. Null-guard (breakdown absent in legacy mode).
- Commit: `feat(coding/ios): readiness breakdown sheet`.

### Task 14 (Android): readiness breakdown sheet
- Mirror Task 13 in `ScaleUpAndroid`.
- Commit: `feat(coding/android): readiness breakdown sheet`.

---

## Self-review (done by author)

- **Spec coverage:** Phase 0 (source of truth + history) → Tasks 1–4. Phase 1 Rule B (competency→primitive map, per-competency mastery with recency+confidence, weighted rollup, bounded behavioral modifier, shadow mode, flag) → Tasks 5–11. Rule A is explicitly deferred to Phase 2 and documented. UI deferred to 1b. ✅
- **Placeholder scan:** every code step shows real code; every test step shows real assertions; commands + expected output are exact. No "TBD". ✅
- **Type/name consistency:** `assembleLegacy`, `persistSnapshot`, `computeComposite`, `assessmentTypesToPrimitive`, `buildCodingSignal`, `buildInterviewSignal`, `buildBehavioralSignal`, `recencyFactor`, `confidenceFrom`, `computeCompetencyMastery` are defined once and referenced consistently. Signal object shape `{score,count,lastAt,hasDifficulty?}` and mastery shape `{score,confidence,primitive}` are stable across tasks. ✅
- **Safety:** no model schema edits to existing primitives; composite is shadow/flagged; all new reads are try/caught with legacy fallback. ✅
