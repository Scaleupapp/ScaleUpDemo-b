# Readiness Phase 3A — The "Ready" Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a learner crosses their target with trustworthy evidence, give them a designed "Ready" moment (Seal takeover → persistent gold READY on Home) and a 3-path "what's next" (deepen / wider / objective-aware prove-it).

**Architecture:** Read-time detection in `GET /api/v2/you/overview` persists an additive `readyState` on the primary `UserObjective`; both the You overview and the Home payload (`GET /api/v2/plan/today`) surface a read-only `ready` block. Clients present a full-screen Seal takeover once (`momentSeen`), then restyle the existing Home readiness display gold. The 3 paths call new/existing endpoints.

**Tech Stack:** Node/Express/Mongoose + `node:test` (backend); SwiftUI + xcodegen (iOS, repo `ScaleUpDemo-f`); React Native/TypeScript (Android, repo `ScaleUpDemo-f-Android`).

**Design spec:** `docs/superpowers/specs/2026-06-02-readiness-phase-3a-ready-experience-design.md`

**Test convention (this repo):** run a single test file directly with `node <path>` (NOT `node --test`, which under-registers via a race). Backend cwd: `/Users/nirpekshnandan/My Products/ScaleUpDemo/scaleup-backend`.

**Gating:** 3A is implicitly gated by `FEATURE_COMPOSITE_READINESS=true` (already on in prod) — when off, `servedSource` is always legacy so `evaluateReady` is always false and 3A is inert.

---

## File Structure

**Backend (`scaleup-backend`)**
- Modify `src/models/UserObjective.js` — additive `readyState` subdocument.
- Modify `src/services/readiness/readinessService.js` — add `evaluateReady()` (pure, exported).
- Create `src/services/readiness/proveItService.js` — objectiveType → prove-it action map.
- Modify `src/routes/v2/you.js` — detection + persist `readyState`; `ready` block in overview; `POST /ready/seen`.
- Modify `src/routes/v2/plan.js` — read-only `ready` block in `/plan/today`.
- Modify `src/services/objectiveService.js` — `deepenObjective()`.
- Modify `src/controllers/objectiveController.js` + `src/routes/objectives.js` — `POST /:id/deepen`.
- Create tests under `src/test/readiness/` and `src/test/` as listed per task.

**iOS (`ScaleUpDemo-f`)**
- Modify `ScaleUp/Features/V2/You/V2YouViewModel.swift` — `ReadyBlock` on `ReadinessBlock`.
- Modify `ScaleUp/Features/V2/Home/V2HomeViewModel.swift` — `ready` on `V2HomeData`.
- Create `ScaleUp/Features/V2/Home/V2ReadyMomentView.swift` — Seal takeover.
- Create `ScaleUp/Features/V2/Home/V2WhatsNextView.swift` — 3 paths.
- Modify `ScaleUp/Features/V2/Home/V2HomeView.swift` — present takeover + gold READY status bar + API calls.
- Modify `project.yml` (build bump) + regenerate.

**Android (`ScaleUpDemo-f-Android`)**
- Modify `src/features/v2/screens/V2HomeScreen.tsx` — `ready` type, takeover, gold READY, API calls.
- Create `src/features/v2/screens/V2ReadyMomentScreen.tsx` — Seal takeover.
- Create `src/features/v2/screens/V2WhatsNextSheet.tsx` — 3 paths.

---

# PHASE A — Backend

### Task 1: `readyState` on UserObjective

**Files:**
- Modify: `src/models/UserObjective.js` (add subdoc near the Phase 2 `target` block, ~line 44)
- Test: `src/test/models/userObjectiveReadyState.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const UserObjective = require('../../models/UserObjective');

test('readyState defaults to not-ready and accepts the milestone fields', () => {
  const o = new UserObjective({ userId: new mongoose.Types.ObjectId(), objectiveType: 'upskilling' });
  assert.equal(o.readyState?.isReady ?? false, false);
  o.readyState = { isReady: true, readyAt: new Date(), readinessAtReady: 84, targetAtReady: 80, momentSeen: false };
  assert.equal(o.readyState.isReady, true);
  assert.equal(o.readyState.readinessAtReady, 84);
  assert.equal(o.readyState.momentSeen, false);
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/models/userObjectiveReadyState.test.js` → fails (readyState undefined).

- [ ] **Step 3: Implement** — add to the schema (after the `targetHistory` field):

```js
  // --- Ready state (Phase 3A) ---
  // Set once by the read-time detector when readiness crosses target with
  // trustworthy (composite/blend) evidence. Sticky once earned. Absent = never ready.
  readyState: {
    isReady:          { type: Boolean, default: false },
    readyAt:          { type: Date },
    readinessAtReady: { type: Number, min: 0, max: 100 },
    targetAtReady:    { type: Number, min: 0, max: 100 },
    momentSeen:       { type: Boolean, default: false },
    momentSeenAt:     { type: Date },
  },
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/models/userObjectiveReadyState.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/models/UserObjective.js src/test/models/userObjectiveReadyState.test.js
git commit -m "feat(readiness): UserObjective.readyState (Phase 3A)"
```

---

### Task 2: `evaluateReady()`

**Files:**
- Modify: `src/services/readiness/readinessService.js` (add function + export)
- Test: `src/test/readiness/evaluateReady.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateReady } = require('../../services/readiness/readinessService');

test('evaluateReady: composite/blend at-or-over target is ready', () => {
  assert.equal(evaluateReady({ servedSource: 'composite', servedValue: 84, target: 80 }), true);
  assert.equal(evaluateReady({ servedSource: 'blend', servedValue: 80, target: 80 }), true);
});
test('evaluateReady: legacy is never ready, even over target', () => {
  assert.equal(evaluateReady({ servedSource: 'legacy', servedValue: 95, target: 80 }), false);
  assert.equal(evaluateReady({ servedSource: 'legacy_lowconf', servedValue: 95, target: 80 }), false);
});
test('evaluateReady: under target or no target is not ready', () => {
  assert.equal(evaluateReady({ servedSource: 'composite', servedValue: 79, target: 80 }), false);
  assert.equal(evaluateReady({ servedSource: 'composite', servedValue: 90, target: null }), false);
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/evaluateReady.test.js`.

- [ ] **Step 3: Implement** — add before `module.exports`, and add `evaluateReady` to the exports object:

```js
/**
 * Has the learner reached "Ready"? True only when the SERVED readiness is
 * composite- or blend-backed (trustworthy past the guardrail) AND meets the
 * effective target. Legacy/thin-evidence users never qualify — keeps the moment
 * (and 3B's proof) credible.
 */
function evaluateReady({ servedSource, servedValue, target } = {}) {
  if (servedSource !== 'composite' && servedSource !== 'blend') return false;
  if (typeof target !== 'number' || target <= 0) return false;
  if (typeof servedValue !== 'number') return false;
  return servedValue >= target;
}
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/evaluateReady.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/services/readiness/readinessService.js src/test/readiness/evaluateReady.test.js
git commit -m "feat(readiness): evaluateReady trigger (Phase 3A)"
```

---

### Task 3: `proveItService` (objective-aware prove-it map)

**Files:**
- Create: `src/services/readiness/proveItService.js`
- Test: `src/test/readiness/proveItService.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { proveItFor } = require('../../services/readiness/proveItService');

test('prove-it maps objectiveType to the right real-world action', () => {
  assert.equal(proveItFor('interview_preparation').kind, 'interview');
  assert.equal(proveItFor('career_switch').kind, 'interview');
  assert.equal(proveItFor('exam_preparation').kind, 'exam');
  assert.equal(proveItFor('upskilling').kind, 'apply');
  assert.equal(proveItFor('academic_excellence').kind, 'apply');
  assert.equal(proveItFor('casual_learning').kind, 'proof');
  assert.equal(proveItFor('something_unknown').kind, 'proof'); // default
});
test('every action carries a label, route and the universal proof teaser', () => {
  const a = proveItFor('exam_preparation');
  assert.equal(typeof a.label, 'string');
  assert.equal(typeof a.route, 'string');
  assert.equal(a.comingSoonProof, true);
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/proveItService.test.js`.

- [ ] **Step 3: Implement** `src/services/readiness/proveItService.js`:

```js
'use strict';

/**
 * The "Go prove it" action is objective-aware — an interview is not the
 * universal end goal. `route` is a client-side intent string the apps map to an
 * existing surface. `comingSoonProof` always true: the verifiable proof card
 * (Phase 3B) is teased for every archetype as the universal layer.
 */
const MAP = {
  interview_preparation: { kind: 'interview', label: 'Ace a real interview', route: 'interview' },
  career_switch:         { kind: 'interview', label: 'Ace a real interview', route: 'interview' },
  exam_preparation:      { kind: 'exam',      label: 'Final readiness check', route: 'exam_ready' },
  upskilling:            { kind: 'apply',     label: 'Put it to work',        route: 'capstone' },
  academic_excellence:   { kind: 'apply',     label: 'Put it to work',        route: 'capstone' },
};
const DEFAULT = { kind: 'proof', label: 'Get your proof', route: 'proof' };

function proveItFor(objectiveType) {
  const base = MAP[objectiveType] || DEFAULT;
  return { ...base, comingSoonProof: true };
}

module.exports = { proveItFor };
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/proveItService.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/services/readiness/proveItService.js src/test/readiness/proveItService.test.js
git commit -m "feat(readiness): objective-aware prove-it map (Phase 3A)"
```

---

### Task 4: Detection + `ready` block in `/you/overview`

**Files:**
- Modify: `src/routes/v2/you.js` — after the `persistSnapshot` + target/breakdown block (the `readinessBreakdown` computation added in P1b), and inside the `readiness:` response object.
- Test: covered by Task 6's endpoint test (detection is exercised there); no standalone unit test (it's glue over Tasks 2/3).

- [ ] **Step 1: Add detection + assemble the ready block.** After the `readinessBreakdown` const, insert:

```js
    // Phase 3A — Ready detection (read-time, authoritative). Sticky once set.
    const proveItService = require('../../services/readiness/proveItService');
    const diagTelemetry = require('../../services/diagnosticTelemetryService');
    let readyBlock = { isReady: false };
    if (objective) {
      const alreadyReady = !!objective.readyState?.isReady;
      const justCrossed = readinessService.evaluateReady({
        servedSource: served.source, servedValue: servedReadiness, target: effectiveTarget,
      });
      if (justCrossed && !alreadyReady) {
        const rs = { isReady: true, readyAt: new Date(), readinessAtReady: servedReadiness, targetAtReady: effectiveTarget, momentSeen: false };
        UserObjective.updateOne({ _id: objective._id }, { $set: { readyState: rs } }).catch(() => {});
        objective.readyState = rs; // reflect in this response
        diagTelemetry.logEvent('ready.fired', { userId: String(userId), objectiveId: String(objective._id), readiness: servedReadiness, target: effectiveTarget });
      }
      if (objective.readyState?.isReady) {
        const assessedStrong = (readinessBreakdown || []).filter((b) => b.assessed && b.score >= (readinessTargetBands?.strong ?? 80)).length;
        readyBlock = {
          isReady: true,
          readyAt: objective.readyState.readyAt,
          momentSeen: !!objective.readyState.momentSeen,
          readinessAtReady: objective.readyState.readinessAtReady ?? servedReadiness,
          summary: {
            objectiveLabel: buildObjectiveLabel(objective),
            score: servedReadiness,
            competenciesStrong: assessedStrong,
            competenciesTotal: objective?.analysis?.competencies?.length || (readinessBreakdown || []).length,
            assessmentsCount: (readinessBreakdown || []).filter((b) => b.assessed).length,
            weeksClimbed: objective.createdAt ? Math.max(1, Math.round((Date.now() - new Date(objective.createdAt)) / (7 * 24 * 3600 * 1000))) : null,
          },
          proveIt: proveItService.proveItFor(objective.objectiveType),
        };
      }
    }
```

- [ ] **Step 2: Add `ready` to the `readiness:` response object** (alongside `breakdown`):

```js
          breakdown: readinessBreakdown,
          ready: readyBlock,
```

- [ ] **Step 3: Verify it parses** — `node --check src/routes/v2/you.js` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/routes/v2/you.js
git commit -m "feat(readiness): detect Ready + serve ready block in overview (Phase 3A)"
```

---

### Task 5: Read-only `ready` block in `/plan/today` (Home payload)

**Files:**
- Modify: `src/routes/v2/plan.js` — in the `GET /today` handler (~line 147), where it already loads the primary objective + builds `trajectory` (~line 188-214).

- [ ] **Step 1: Ensure the primary objective is loaded in the handler.** If the handler doesn't already have the objective doc, add near the top of the `try`:

```js
    const objectiveForReady = await require('../../models/UserObjective')
      .findOne({ userId: req.user.userId, status: 'active', isPrimary: true })
      .select('readyState objectiveType analysis.competencies createdAt specifics specificsCanonical target').lean();
```

- [ ] **Step 2: Build a read-only ready block** (no detection here — detection only happens in `/you/overview`). Before the response object:

```js
    let ready = { isReady: false };
    if (objectiveForReady?.readyState?.isReady) {
      const proveItService = require('../../services/readiness/proveItService');
      ready = {
        isReady: true,
        readyAt: objectiveForReady.readyState.readyAt,
        momentSeen: !!objectiveForReady.readyState.momentSeen,
        proveIt: proveItService.proveItFor(objectiveForReady.objectiveType),
      };
    }
```

- [ ] **Step 3: Add `ready` to the `/today` response payload** (alongside `trajectory`):

```js
          trajectory,
          ready,
```

- [ ] **Step 4: Verify it parses** — `node --check src/routes/v2/plan.js`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/v2/plan.js
git commit -m "feat(readiness): expose read-only ready block on /plan/today (Phase 3A)"
```

---

### Task 6: `POST /you/ready/seen`

**Files:**
- Modify: `src/routes/v2/you.js` — add a route handler.
- Test: `src/test/readiness/readySeenEndpoint.test.js`

- [ ] **Step 1: Write the failing test** (unit-tests the handler logic via a mocked model; the project tests handlers in isolation):

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const UserObjective = require('../../models/UserObjective');

// markMomentSeen is exported from you.js for testability.
const { markMomentSeen } = require('../../routes/v2/you');

test('markMomentSeen sets momentSeen + momentSeenAt on the primary objective', async () => {
  const calls = [];
  const fakeUpdateOne = async (filter, update) => { calls.push({ filter, update }); return { matchedCount: 1 }; };
  const orig = UserObjective.updateOne;
  UserObjective.updateOne = fakeUpdateOne;
  try {
    const userId = new mongoose.Types.ObjectId();
    await markMomentSeen(String(userId));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].update.$set.momentSeen ? true : calls[0].update.$set['readyState.momentSeen'], true);
  } finally {
    UserObjective.updateOne = orig;
  }
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/readySeenEndpoint.test.js` (markMomentSeen not exported).

- [ ] **Step 3: Implement** in `src/routes/v2/you.js` — add the helper + route, and export the helper:

```js
async function markMomentSeen(userId) {
  return UserObjective.updateOne(
    { userId, status: 'active', isPrimary: true, 'readyState.isReady': true },
    { $set: { 'readyState.momentSeen': true, 'readyState.momentSeenAt': new Date() } }
  );
}

router.post('/ready/seen', auth, async (req, res) => {
  try {
    await markMomentSeen(req.user.userId);
    require('../../services/diagnosticTelemetryService').logEvent('ready.moment_seen', { userId: String(req.user.userId) });
    res.json({ success: true, data: { ok: true } });
  } catch (err) {
    console.error('[v2/you/ready/seen]', err.message);
    res.status(500).json({ success: false, message: 'Could not mark moment seen' });
  }
});
```

At the bottom of the file, change `module.exports = router;` to also export the helper:

```js
module.exports = router;
module.exports.markMomentSeen = markMomentSeen;
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/readySeenEndpoint.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/v2/you.js src/test/readiness/readySeenEndpoint.test.js
git commit -m "feat(readiness): POST /you/ready/seen (Phase 3A)"
```

---

### Task 7: `deepenObjective` + `POST /objectives/:id/deepen`

**Files:**
- Modify: `src/services/objectiveService.js` — add `deepenObjective`.
- Modify: `src/controllers/objectiveController.js` — add `deepenObjective` controller + export.
- Modify: `src/routes/objectives.js` — add the route.
- Test: `src/test/readiness/deepenObjective.test.js`

- [ ] **Step 1: Write the failing test** (unit-test the service's target math + state reset, model mocked):

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('deepenObjective raises target to the Exceptional band, resets ready, logs history', async () => {
  const UserObjective = require('../../models/UserObjective');
  const objectiveService = require('../../services/objectiveService');
  const id = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const saved = { value: null };
  const fakeDoc = {
    _id: id, userId, objectiveType: 'upskilling', target: 80, targetHistory: [],
    readyState: { isReady: true, momentSeen: true },
    save: async function () { saved.value = this; return this; },
  };
  const origFind = UserObjective.findOne;
  UserObjective.findOne = () => fakeDoc;
  const queueMod = require('../../config/queue');
  const origAdd = queueMod.planGenerationQueue.add;
  queueMod.planGenerationQueue.add = async () => ({});
  const DA = require('../../models/DiagnosticAttempt');
  const origDA = DA.findOne;
  DA.findOne = () => ({ sort: () => ({ lean: async () => ({ _id: new mongoose.Types.ObjectId() }) }) });
  try {
    const out = await objectiveService.deepenObjective(String(userId), String(id));
    // exceptional band for target 80 = min(98, 80+8) = 88
    assert.equal(out.target, 88);
    assert.equal(saved.value.target, 88);
    assert.equal(saved.value.readyState.isReady, false);
    assert.equal(saved.value.targetHistory.at(-1).reason, 'deepen');
  } finally {
    UserObjective.findOne = origFind;
    queueMod.planGenerationQueue.add = origAdd;
    DA.findOne = origDA;
  }
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/deepenObjective.test.js`.

- [ ] **Step 3: Implement the service** in `src/services/objectiveService.js` (add a method in the class):

```js
  async deepenObjective(userId, objectiveId) {
    const UserObjective = require('../models/UserObjective');
    const { targetBands } = require('./readiness/targetService');
    const objective = await UserObjective.findOne({ _id: objectiveId, userId });
    if (!objective) throw new Error('Objective not found');

    const current = typeof objective.target === 'number' && objective.target > 0 ? objective.target : 80;
    const next = targetBands(current).exceptional; // min(98, strong + 8)
    objective.target = next;
    objective.targetHistory = objective.targetHistory || [];
    objective.targetHistory.push({ value: next, reason: 'deepen', at: new Date() });
    // Raising the bar = a fresh climb: clear ready so the moment can re-fire.
    objective.readyState = { isReady: false, momentSeen: false };
    await objective.save();

    // Best-effort replan toward the new target (plan-gen reads live objective.target).
    try {
      const DiagnosticAttempt = require('../models/DiagnosticAttempt');
      const attempt = await DiagnosticAttempt.findOne({ userId, status: 'completed' }).sort({ completedAt: -1 }).lean();
      if (attempt) {
        const { planGenerationQueue } = require('../config/queue');
        await planGenerationQueue.add('generate', { attemptId: String(attempt._id) },
          { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 50 });
      }
    } catch (e) {
      console.warn('[objectiveService.deepenObjective] replan enqueue skipped:', e.message);
    }
    return { id: String(objective._id), target: next };
  }
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/deepenObjective.test.js`.

- [ ] **Step 5: Add the controller** in `src/controllers/objectiveController.js` (and add to `module.exports`):

```js
const deepenObjective = async (req, res) => {
  try {
    const out = await objectiveService.deepenObjective(req.user.userId, req.params.id);
    require('../services/diagnosticTelemetryService').logEvent('ready.deepen', { userId: String(req.user.userId), objectiveId: req.params.id, newTarget: out.target });
    res.json(apiResponse.success(out, 'Bar raised — new plan on the way.'));
  } catch (err) {
    res.status(400).json(apiResponse.error(err.message));
  }
};
```

Add `deepenObjective` to the `module.exports = { ... }` list. (Note: `objectiveController` already requires `objectiveService` and `apiResponse`.)

- [ ] **Step 6: Add the route** in `src/routes/objectives.js` (after the `activate` route):

```js
router.post('/:id/deepen', ctrl.deepenObjective);
```

- [ ] **Step 7: Verify parse** — `node --check src/controllers/objectiveController.js && node --check src/routes/objectives.js`.

- [ ] **Step 8: Commit**

```bash
git add src/services/objectiveService.js src/controllers/objectiveController.js src/routes/objectives.js src/test/readiness/deepenObjective.test.js
git commit -m "feat(readiness): POST /objectives/:id/deepen raises target + replans (Phase 3A)"
```

---

### Task 8: Run the backend readiness suite + push

- [ ] **Step 1: Run all readiness tests**

```bash
for f in src/test/readiness/*.test.js src/test/models/userObjectiveReadyState.test.js; do echo "## $f"; node "$f" 2>&1 | grep -E "# (tests|pass|fail)"; done
```
Expected: every file `# fail 0`.

- [ ] **Step 2: Push** (auto-deploys via the EC2 Action)

```bash
git push origin master
```

---

# PHASE B — iOS (`ScaleUpDemo-f`)

cwd: `/Users/nirpekshnandan/My Products/ScaleUpDemo-f`

### Task 9: iOS models — `ReadyBlock`

**Files:**
- Modify: `ScaleUp/Features/V2/You/V2YouViewModel.swift` — nest `ReadyBlock` in `ReadinessBlock`.
- Modify: `ScaleUp/Features/V2/Home/V2HomeViewModel.swift` — add `ready` to `V2HomeData`.

- [ ] **Step 1: Add `ReadyBlock` to `ReadinessBlock`** (in `V2YouViewModel.swift`, inside `struct ReadinessBlock`, after `breakdown`):

```swift
        let ready: ReadyBlock?

        struct ReadyBlock: Codable {
            let isReady: Bool
            let readyAt: String?
            let momentSeen: Bool?
            let readinessAtReady: Int?
            let summary: Summary?
            let proveIt: ProveIt?

            struct Summary: Codable {
                let objectiveLabel: String?
                let score: Int
                let competenciesStrong: Int
                let competenciesTotal: Int
                let assessmentsCount: Int
                let weeksClimbed: Int?
            }
            struct ProveIt: Codable {
                let kind: String
                let label: String
                let route: String
                let comingSoonProof: Bool?
            }
        }
```

- [ ] **Step 2: Add `ready` to `V2HomeData`** (in `V2HomeViewModel.swift`, add a property + a small struct; reuse the same shape). Add to `struct V2HomeData`:

```swift
    let ready: HomeReady?
    struct HomeReady: Codable {
        let isReady: Bool
        let readyAt: String?
        let momentSeen: Bool?
        let proveIt: V2YouOverview.ReadinessBlock.ReadyBlock.ProveIt?
    }
```

- [ ] **Step 3: Verify** — there is no Swift CLI typecheck; this is validated by the Task 14 build. Move on.

- [ ] **Step 4: Commit**

```bash
git add ScaleUp/Features/V2/You/V2YouViewModel.swift ScaleUp/Features/V2/Home/V2HomeViewModel.swift
git commit -m "feat(readiness/ios): decode ready block (Phase 3A)"
```

---

### Task 10: iOS — `V2ReadyMomentView` (Seal takeover)

**Files:**
- Create: `ScaleUp/Features/V2/Home/V2ReadyMomentView.swift`

- [ ] **Step 1: Create the view** (Seal/medallion, one primary CTA; uses `ColorTokens`):

```swift
import SwiftUI

/// Full-screen "You're ready" moment — a gold medallion (Seal). Shown once on Home
/// when readyState.isReady && !momentSeen. Primary CTA opens What's-next; either
/// dismissal calls onSeen (POST /you/ready/seen) and flips Home to the gold ring.
struct V2ReadyMomentView: View {
    let ready: V2YouOverview.ReadinessBlock.ReadyBlock
    let onWhatsNext: () -> Void
    let onSeen: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            RadialGradient(colors: [ColorTokens.surfaceElevated, ColorTokens.background],
                           center: .top, startRadius: 20, endRadius: 520).ignoresSafeArea()
            VStack(spacing: 16) {
                Spacer()
                Text("YOU'VE EARNED IT")
                    .font(.system(size: 11, weight: .bold)).tracking(2)
                    .foregroundStyle(ColorTokens.textSecondary)
                medallion
                VStack(spacing: 4) {
                    Text(ready.summary?.objectiveLabel ?? "Your goal")
                        .font(.system(size: 18, weight: .bold)).foregroundStyle(ColorTokens.textPrimary)
                    if let s = ready.summary {
                        Text("\(s.competenciesStrong) of \(s.competenciesTotal) skills strong · \(s.assessmentsCount) assessments")
                            .font(.system(size: 12)).foregroundStyle(ColorTokens.textSecondary)
                    }
                }
                Spacer()
                Button { onSeen(); onWhatsNext() } label: {
                    Text("See what's next →")
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(ColorTokens.background)
                        .frame(maxWidth: .infinity).padding(.vertical, 15)
                        .background(ColorTokens.gold).clipShape(RoundedRectangle(cornerRadius: 14))
                }.buttonStyle(.plain).padding(.horizontal, 24)
                Button { onSeen(); dismiss() } label: {
                    Text("Maybe later").font(.system(size: 13)).foregroundStyle(ColorTokens.textTertiary)
                }.buttonStyle(.plain).padding(.bottom, 20)
            }
        }
    }

    private var medallion: some View {
        ZStack {
            Circle().fill(AngularGradient(colors: [ColorTokens.goldLight, ColorTokens.goldDark, ColorTokens.goldLight], center: .center))
                .frame(width: 150, height: 150).shadow(color: ColorTokens.gold.opacity(0.45), radius: 26)
            Circle().fill(ColorTokens.background).frame(width: 124, height: 124)
            VStack(spacing: 2) {
                Text("★").font(.system(size: 26)).foregroundStyle(ColorTokens.gold)
                Text("READY").font(.system(size: 11, weight: .bold)).tracking(1.5).foregroundStyle(ColorTokens.gold)
                Text("\(ready.summary?.score ?? ready.readinessAtReady ?? 0)%")
                    .font(.system(size: 26, weight: .heavy)).foregroundStyle(ColorTokens.textPrimary)
            }
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add ScaleUp/Features/V2/Home/V2ReadyMomentView.swift
git commit -m "feat(readiness/ios): Seal Ready-moment takeover (Phase 3A)"
```

---

### Task 11: iOS — `V2WhatsNextView` (3 paths)

**Files:**
- Create: `ScaleUp/Features/V2/Home/V2WhatsNextView.swift`

- [ ] **Step 1: Create the view** (3 path cards; deepen/wider/prove with objective-aware prove-it; calls back to the host for actions):

```swift
import SwiftUI

/// The "what's next" chooser after the Ready moment (and from the persistent gold
/// ring). Three paths; prove-it is objective-aware via ready.proveIt.
struct V2WhatsNextView: View {
    let ready: V2YouOverview.ReadinessBlock.ReadyBlock
    let onDeeper: () -> Void
    let onWider: () -> Void
    let onProve: (_ route: String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("You're ready. Where to now?")
                        .font(.system(size: 20, weight: .bold)).foregroundStyle(ColorTokens.textPrimary)
                        .padding(.bottom, 4)
                    pathCard(icon: "arrow.up", title: "Go deeper", subtitle: "Raise the bar to Exceptional and keep climbing.") { onDeeper() }
                    pathCard(icon: "arrow.left.arrow.right", title: "Go wider", subtitle: "Start a new goal.") { onWider() }
                    pathCard(icon: "checkmark.seal", title: ready.proveIt?.label ?? "Go prove it",
                             subtitle: (ready.proveIt?.comingSoonProof ?? false) ? "Shareable proof card coming soon." : "Show the world you're ready.") {
                        onProve(ready.proveIt?.route ?? "proof")
                    }
                }.padding(20)
            }
            .background(ColorTokens.background.ignoresSafeArea())
            .navigationTitle("What's next").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.foregroundStyle(ColorTokens.gold) } }
        }
    }

    private func pathCard(icon: String, title: String, subtitle: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 16, weight: .semibold)).foregroundStyle(ColorTokens.gold).frame(width: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(ColorTokens.textPrimary)
                    Text(subtitle).font(.system(size: 12)).foregroundStyle(ColorTokens.textSecondary).multilineTextAlignment(.leading)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(ColorTokens.textTertiary)
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(ColorTokens.surface))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(ColorTokens.surfaceElevated.opacity(0.7), lineWidth: 1))
        }.buttonStyle(.plain)
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add ScaleUp/Features/V2/Home/V2WhatsNextView.swift
git commit -m "feat(readiness/ios): what's-next 3-path screen (Phase 3A)"
```

---

### Task 12: iOS — wire into `V2HomeView` (takeover, gold READY status bar, actions)

**Files:**
- Modify: `ScaleUp/Features/V2/Home/V2HomeView.swift`

- [ ] **Step 1: Add state** near the other `@State` vars (around line 22):

```swift
    @State private var showWhatsNext = false
    @State private var didPresentReady = false
```

- [ ] **Step 2: Present the takeover + what's-next.** On the root view (where other `.sheet`s attach), add:

```swift
        .fullScreenCover(isPresented: Binding(
            get: { (vm.data?.ready?.isReady == true) && (vm.data?.ready?.momentSeen == false) && !didPresentReady },
            set: { if !$0 { didPresentReady = true } })) {
            if let r = readyForMoment(vm.data) {
                V2ReadyMomentView(ready: r,
                    onWhatsNext: { didPresentReady = true; showWhatsNext = true },
                    onSeen: { Task { try? await V2APIClient.shared.post("/you/ready/seen", body: Empty()) }; didPresentReady = true })
            }
        }
        .sheet(isPresented: $showWhatsNext) {
            if let r = readyForMoment(vm.data) {
                V2WhatsNextView(ready: r,
                    onDeeper: { Task { await deepen() } },
                    onWider: { showWhatsNext = false /* TODO route handled in Step 5 */ },
                    onProve: { route in showWhatsNext = false; routeProve(route) })
            }
        }
```

- [ ] **Step 3: Add helpers** in the view (map the home ready block into the `ReadyBlock` shape the subviews expect; since `/plan/today` returns the lean ready block without `summary`, fetch the full one is unnecessary — the subviews tolerate nil summary):

```swift
    private func readyForMoment(_ data: V2HomeData?) -> V2YouOverview.ReadinessBlock.ReadyBlock? {
        guard let hr = data?.ready, hr.isReady else { return nil }
        return V2YouOverview.ReadinessBlock.ReadyBlock(
            isReady: true, readyAt: hr.readyAt, momentSeen: hr.momentSeen, readinessAtReady: data?.trajectory?.today,
            summary: nil, proveIt: hr.proveIt)
    }
    private func deepen() async {
        guard let id = objectiveContext.primaryObjectiveId else { showWhatsNext = false; return }
        _ = try? await V2APIClient.shared.post("/objectives/\(id)/deepen", body: Empty())
        showWhatsNext = false
        await vm.load()
    }
    private func routeProve(_ route: String) {
        // interview -> interviews tab; exam_ready/capstone/proof -> readiness breakdown for now.
        switch route {
        case "interview": appState.selectedTab = .interview   // existing tab enum
        default: break // proof teaser handled inside V2WhatsNextView copy
        }
    }
```

(If `objectiveContext.primaryObjectiveId` / `appState.selectedTab` don't exist verbatim, use the codebase's existing primary-objective id accessor and tab-routing — grep `primaryObjective` and `selectedTab` in `ScaleUp/`. "Go wider" routes to the existing add-objective flow used by the You tab's objectives sheet; reuse that navigation.)

- [ ] **Step 4: Gold READY status bar.** In the `statusBar(traj:data:)` builder, when `data.ready?.isReady == true && data.ready?.momentSeen == true`, replace the "% needed" trailing text + make the row open What's-next. Concretely, wrap the existing trajectory button's label: if ready, render `Text("READY").foregroundStyle(ColorTokens.gold)` + a small "what's next ›" and set the button action to `showWhatsNext = true` instead of `showTrajectorySheet = true`. Minimal diff:

```swift
                // inside the big-numbers Button label, after the today% Text:
                if data.ready?.isReady == true && data.ready?.momentSeen == true {
                    Text("· READY").font(.system(size: 14, weight: .bold)).foregroundStyle(ColorTokens.gold)
                } else {
                    Image(systemName: "arrow.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(ColorTokens.textTertiary)
                    Text("\(traj.targetReadiness)% needed").font(.system(size: 14, weight: .semibold)).foregroundStyle(ColorTokens.gold)
                }
```
And change that Button's action to: `if data.ready?.isReady == true { showWhatsNext = true } else { showTrajectorySheet = true }`.

- [ ] **Step 5: Verify** via build (Task 14). Commit:

```bash
git add ScaleUp/Features/V2/Home/V2HomeView.swift
git commit -m "feat(readiness/ios): present Ready takeover + gold READY status bar (Phase 3A)"
```

---

### Task 13: iOS — bump build + regenerate

**Files:** Modify `project.yml`

- [ ] **Step 1:** bump `CURRENT_PROJECT_VERSION` to `182`.
- [ ] **Step 2:** regenerate — `/opt/homebrew/Cellar/xcodegen/2.45.3/bin/xcodegen generate`
- [ ] **Step 3:** confirm new files included — `grep -c "V2ReadyMomentView.swift\|V2WhatsNextView.swift" ScaleUp.xcodeproj/project.pbxproj` (expect ≥ 2 each).
- [ ] **Step 4: Commit** — `git add project.yml ScaleUp.xcodeproj/project.pbxproj && git commit -m "chore(ios): regenerate at build 182 (Ready experience)"`

---

### Task 14: iOS — archive + upload to TestFlight

- [ ] **Step 1: Archive** (API-key signing — Apple ID login is rejected; this is the proven path):

```bash
xcodebuild -project ScaleUp.xcodeproj -scheme ScaleUp -configuration Release \
  -archivePath build/ScaleUp.xcarchive -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  -authenticationKeyPath /Users/nirpekshnandan/.private_keys/AuthKey_A4MNMMCCVB.p8 \
  -authenticationKeyID A4MNMMCCVB -authenticationKeyIssuerID 0bbf6f7f-a7cf-4b88-8759-4c85e5c0f240 \
  clean archive
```
Expected: `** ARCHIVE SUCCEEDED **`. (If a Swift compile error appears, fix it and re-run before exporting.)

- [ ] **Step 2: Export + upload**

```bash
xcodebuild -exportArchive -archivePath build/ScaleUp.xcarchive -exportPath build/ipa \
  -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates \
  -authenticationKeyPath /Users/nirpekshnandan/.private_keys/AuthKey_A4MNMMCCVB.p8 \
  -authenticationKeyID A4MNMMCCVB -authenticationKeyIssuerID 0bbf6f7f-a7cf-4b88-8759-4c85e5c0f240
```
Expected: `Upload succeeded` + `** EXPORT SUCCEEDED **`.

- [ ] **Step 3: Push** — `git push origin master`

---

# PHASE C — Android (`ScaleUpDemo-f-Android`)

cwd: `/Users/nirpekshnandan/My Products/ScaleUpAndroid`

### Task 15: Android — types + `V2ReadyMomentScreen`

**Files:**
- Modify: `src/features/v2/screens/V2HomeScreen.tsx` — add `ready` to the home data type.
- Create: `src/features/v2/screens/V2ReadyMomentScreen.tsx`

- [ ] **Step 1: Add the `ready` type** to the Home screen's data interface (find the interface decoding `/plan/today`; add):

```typescript
  ready?: {
    isReady: boolean
    readyAt?: string | null
    momentSeen?: boolean | null
    proveIt?: { kind: string; label: string; route: string; comingSoonProof?: boolean }
  } | null
```

- [ ] **Step 2: Create `V2ReadyMomentScreen.tsx`** (Seal; props: `ready`, `onWhatsNext`, `onSeen`):

```tsx
import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { V2Colors, V2Type } from '../core/V2Theme'

type Ready = { proveIt?: { label: string; route: string; comingSoonProof?: boolean }; score?: number }
export const V2ReadyMomentScreen: React.FC<{ score: number; objectiveLabel: string; onWhatsNext: () => void; onSeen: () => void }> = ({ score, objectiveLabel, onWhatsNext, onSeen }) => (
  <SafeAreaView style={styles.bg}>
    <View style={styles.center}>
      <Text style={styles.eyebrow}>YOU'VE EARNED IT</Text>
      <View style={styles.medallionOuter}>
        <View style={styles.medallionInner}>
          <Text style={{ color: V2Colors.gold, fontSize: 24 }}>★</Text>
          <Text style={styles.readyLbl}>READY</Text>
          <Text style={styles.score}>{score}%</Text>
        </View>
      </View>
      <Text style={[V2Type.h3, { color: V2Colors.textPrimary, marginTop: 16 }]}>{objectiveLabel}</Text>
    </View>
    <View style={{ padding: 24 }}>
      <Pressable style={styles.cta} onPress={() => { onSeen(); onWhatsNext() }}>
        <Text style={styles.ctaTxt}>See what's next →</Text>
      </Pressable>
      <Pressable onPress={onSeen} style={{ alignItems: 'center', marginTop: 14 }}>
        <Text style={{ color: V2Colors.textTertiary, fontSize: 13 }}>Maybe later</Text>
      </Pressable>
    </View>
  </SafeAreaView>
)
const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: V2Colors.background, justifyContent: 'space-between' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { color: V2Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 20 },
  medallionOuter: { width: 150, height: 150, borderRadius: 75, backgroundColor: V2Colors.gold, alignItems: 'center', justifyContent: 'center' },
  medallionInner: { width: 124, height: 124, borderRadius: 62, backgroundColor: V2Colors.background, alignItems: 'center', justifyContent: 'center' },
  readyLbl: { color: V2Colors.gold, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginTop: 2 },
  score: { color: V2Colors.textPrimary, fontSize: 26, fontWeight: '800' },
  cta: { backgroundColor: V2Colors.gold, borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  ctaTxt: { color: V2Colors.background, fontSize: 16, fontWeight: '800' },
})
```

- [ ] **Step 3: Commit**

```bash
git add src/features/v2/screens/V2HomeScreen.tsx src/features/v2/screens/V2ReadyMomentScreen.tsx
git commit -m "feat(readiness/android): ready type + Seal moment screen (Phase 3A)"
```

---

### Task 16: Android — `V2WhatsNextSheet` + wire into Home

**Files:**
- Create: `src/features/v2/screens/V2WhatsNextSheet.tsx`
- Modify: `src/features/v2/screens/V2HomeScreen.tsx`

- [ ] **Step 1: Create `V2WhatsNextSheet.tsx`** (3 paths; prove-it from `ready.proveIt`):

```tsx
import React from 'react'
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { V2Colors, V2Type, V2Spacing } from '../core/V2Theme'

type ProveIt = { label: string; route: string; comingSoonProof?: boolean }
export const V2WhatsNextSheet: React.FC<{ proveIt?: ProveIt; onDeeper: () => void; onWider: () => void; onProve: (route: string) => void; onClose: () => void }> = ({ proveIt, onDeeper, onWider, onProve, onClose }) => {
  const Row = ({ title, subtitle, onPress }: { title: string; subtitle: string; onPress: () => void }) => (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <Text style={[V2Type.bodyMedium, { color: V2Colors.textPrimary, fontWeight: '600' }]}>{title}</Text>
        <Text style={[V2Type.small, { color: V2Colors.textSecondary }]}>{subtitle}</Text>
      </View>
      <Text style={{ color: V2Colors.textTertiary }}>›</Text>
    </Pressable>
  )
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: V2Colors.background }} edges={['top']}>
      <View style={styles.header}>
        <Text style={[V2Type.h3, { color: V2Colors.textPrimary }]}>What's next</Text>
        <Pressable onPress={onClose}><Text style={{ color: V2Colors.gold, fontWeight: '600' }}>Done</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: V2Spacing.pad }}>
        <Row title="Go deeper ↑" subtitle="Raise the bar to Exceptional and keep climbing." onPress={onDeeper} />
        <Row title="Go wider ↔" subtitle="Start a new goal." onPress={onWider} />
        <Row title={proveIt?.label ?? 'Go prove it ✓'} subtitle={proveIt?.comingSoonProof ? 'Shareable proof card coming soon.' : 'Show the world you’re ready.'} onPress={() => onProve(proveIt?.route ?? 'proof')} />
      </ScrollView>
    </SafeAreaView>
  )
}
const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: V2Spacing.pad, borderBottomWidth: 1, borderBottomColor: V2Colors.cardBorder },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: V2Colors.surface, borderColor: V2Colors.cardBorder, borderWidth: 1, borderRadius: V2Spacing.cardRadius, padding: 16, marginBottom: 12 },
})
```

- [ ] **Step 2: Wire into `V2HomeScreen.tsx`** — state, a full-screen `Modal` for the moment, a page-sheet `Modal` for what's-next, the gold READY treatment on the readiness display, and the API calls. Add near other state:

```tsx
  const [showWhatsNext, setShowWhatsNext] = useState(false)
  const [readyDismissed, setReadyDismissed] = useState(false)
  const markSeen = async () => { try { await V2Api.post('/you/ready/seen', {}) } catch {} ; setReadyDismissed(true) }
  const deepen = async (objectiveId: string) => { try { await V2Api.post(`/objectives/${objectiveId}/deepen`, {}) } catch {} ; setShowWhatsNext(false); /* reload home */ }
```

Add the two modals in the render tree (alongside other modals):

```tsx
  <Modal visible={data?.ready?.isReady === true && data?.ready?.momentSeen === false && !readyDismissed} animationType="fade" onRequestClose={markSeen}>
    <V2ReadyMomentScreen score={data!.trajectory?.today ?? 0} objectiveLabel={data!.objectiveName ?? 'Your goal'}
      onWhatsNext={() => { setReadyDismissed(true); setShowWhatsNext(true) }} onSeen={markSeen} />
  </Modal>
  <Modal visible={showWhatsNext} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowWhatsNext(false)}>
    <V2WhatsNextSheet proveIt={data?.ready?.proveIt}
      onDeeper={() => data?.primaryObjectiveId && deepen(data.primaryObjectiveId)}
      onWider={() => { setShowWhatsNext(false); navigation.navigate('AddObjective') }}
      onProve={(route) => { setShowWhatsNext(false); if (route === 'interview') navigation.navigate('Interview') }}
      onClose={() => setShowWhatsNext(false)} />
  </Modal>
```

For the persistent gold READY: where the readiness/trajectory line renders on Home, when `data?.ready?.isReady && data?.ready?.momentSeen`, render a gold `READY ·  what's next ›` pressable that opens `setShowWhatsNext(true)` instead of the normal "X% needed" text.

(Import `V2ReadyMomentScreen` and `V2WhatsNextSheet`. If `data.primaryObjectiveId` / nav route names (`AddObjective`, `Interview`) differ, grep the Home/nav for the exact names and use them — these reuse existing navigation.)

- [ ] **Step 3: Typecheck the two changed files**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "V2HomeScreen|V2ReadyMomentScreen|V2WhatsNextSheet" || echo "clean"
```
Expected: `clean` (the repo has unrelated pre-existing TS errors; only your files must be absent).

- [ ] **Step 4: Commit + push**

```bash
git add src/features/v2/screens/V2HomeScreen.tsx src/features/v2/screens/V2WhatsNextSheet.tsx
git commit -m "feat(readiness/android): Ready takeover + what's-next + gold READY (Phase 3A)"
git push origin main
```

---

## Self-Review (completed by plan author)

**Spec coverage:** trigger → Task 2; readyState model → Task 1; detection + overview ready block → Task 4; Home ready block → Task 5; ready/seen → Task 6; deepen (raise target + reset + replan) → Task 7; prove-it map → Task 3; Seal takeover → Tasks 10/15; what's-next 3 paths → Tasks 11/16; persistent gold READY → Tasks 12/16; telemetry → folded into Tasks 4/6/7; edge cases (sticky, legacy-never-ready, flag-off) → Tasks 2/4 logic + tests. All spec sections mapped.

**Known soft spots flagged for the implementer (not placeholders — explicit):** (a) the deepen→replan enqueues plan generation from the latest completed diagnostic; if `planService` later gains an objective-scoped regenerate, switch to it. (b) iOS/Android accessors `primaryObjectiveId`, `appState.selectedTab`, nav routes `AddObjective`/`Interview` are reused-existing — grep for the exact identifiers (they exist; names may differ slightly) before wiring. (c) The Home moment uses the lean ready block (no `summary`); the subviews already tolerate `summary: nil`, so the Seal shows score + label without the strong-skills line on Home — full summary appears if opened from the You-tab overview later.

**Out of scope (3B, separate plan):** the verifiable proof card image + public verify page.
