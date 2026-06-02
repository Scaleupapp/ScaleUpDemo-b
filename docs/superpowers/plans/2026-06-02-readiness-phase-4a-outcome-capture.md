# Readiness Phase 4A — Outcome Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capture each user's real outcome (got the job / passed / not yet …) with the frozen readiness context — the dataset Phase 4B will calibrate against — and stamp the 3B proof "✓ ACHIEVED" on success.

**Architecture:** A `ObjectiveOutcome` record freezes the outcome label + the readiness context (read from `ReadinessSnapshot` history). The capture prompt is surfaced via an `outcomePrompt` block folded into `/you/overview` + `/plan/today` (lazy "target date passed" check), plus an always-on "I got it!" affordance. `POST /you/outcome` records it, marks the objective, and stamps the active `ReadinessProof`.

**Tech Stack:** Node/Express/Mongoose + `node:test` (backend); SwiftUI (iOS, `ScaleUpDemo-f`); React Native/TS (Android, `ScaleUpDemo-f-Android`).

**Design spec:** `docs/superpowers/specs/2026-06-02-readiness-phase-4-outcome-calibration-design.md` (build PART 4A only; PART 4B is documented for later — do NOT build it).
**Builds on:** P0–P3 (readiness engine, `UserObjective.readyState`, `ReadinessProof` from 3B, `proveItService` pattern).
**Test convention:** single file = `node <path>` (NOT `node --test`). Backend cwd: `/Users/nirpekshnandan/My Products/ScaleUpDemo/scaleup-backend`.

---

## File Structure

**Backend (`scaleup-backend`)**
- Create `src/models/ObjectiveOutcome.js`.
- Create `src/services/readiness/outcomeService.js` — taxonomy options, `labelFor`, `buildContext`, `recordOutcome`, `isDue`.
- Modify `src/models/UserObjective.js` — additive `outcomePrompt` subdoc.
- Modify `src/models/ReadinessProof.js` — additive `achieved`/`achievedAt` + `snapshot.achievedLabel`.
- Modify `src/routes/v2/you.js` — `POST /outcome`, `POST /outcome/snooze`, `outcomePrompt` block in overview.
- Modify `src/routes/v2/plan.js` — `outcomePrompt` block in `/today`.
- Tests under `src/test/readiness/`.

**iOS (`ScaleUpDemo-f`)**
- Create `ScaleUp/Features/V2/Home/V2OutcomeSheet.swift`.
- Modify `ScaleUp/Features/V2/Home/V2HomeViewModel.swift` — `outcomePrompt` on `V2HomeData`.
- Modify `ScaleUp/Features/V2/Home/V2HomeView.swift` — surface the sheet + "I got it!".
- Modify `project.yml` (build 184) + regenerate.

**Android (`ScaleUpDemo-f-Android`)**
- Create `src/features/v2/screens/V2OutcomeSheet.tsx`.
- Modify `src/features/v2/screens/V2HomeScreen.tsx` — `outcomePrompt` type + surface + "I got it!".

---

# PHASE A — Backend

### Task 1: `ObjectiveOutcome` model

**Files:** Create `src/models/ObjectiveOutcome.js`; Test `src/test/readiness/objectiveOutcomeModel.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const ObjectiveOutcome = require('../../models/ObjectiveOutcome');

test('ObjectiveOutcome holds label + frozen context', () => {
  const o = new ObjectiveOutcome({
    userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId(),
    objectiveType: 'interview_preparation', label: 'SUCCESS', rawChoice: 'got_role', source: 'i_got_it',
    context: { readinessAtCapture: 84, targetAtCapture: 80, bandAtCapture: 'Strong', readinessAtTarget: 82,
      peakReadiness: 86, wasEverReady: true, coverageAtCapture: 0.75, weeksToOutcome: 14 },
  });
  assert.equal(o.label, 'SUCCESS');
  assert.equal(o.resolved, true);
  assert.equal(o.context.peakReadiness, 86);
  assert.equal(o.allowTestimonialUse, false);
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/objectiveOutcomeModel.test.js`

- [ ] **Step 3: Implement** `src/models/ObjectiveOutcome.js`

```js
'use strict';
const mongoose = require('mongoose');

/** A self-reported real-world outcome for an objective, with the frozen readiness
 *  context Phase 4B calibrates against. PENDING records are re-askable. */
const ObjectiveOutcomeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', required: true, index: true },
    objectiveType: { type: String },
    label: { type: String, enum: ['SUCCESS', 'PARTIAL', 'NOT_SUCCESS', 'PENDING', 'ABANDONED'], required: true },
    rawChoice: { type: String },
    detail: { type: mongoose.Schema.Types.Mixed },
    source: { type: String, enum: ['target_date_prompt', 'i_got_it', 'objective_close', 'reprompt'] },
    context: {
      readinessAtCapture: Number,
      targetAtCapture: Number,
      bandAtCapture: String,
      readinessAtTarget: Number,
      peakReadiness: Number,
      wasEverReady: Boolean,
      coverageAtCapture: Number,
      weeksToOutcome: Number,
    },
    testimonial: { type: String },
    allowTestimonialUse: { type: Boolean, default: false },
    resolved: { type: Boolean, default: true },
    respondedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
ObjectiveOutcomeSchema.index({ userId: 1, objectiveId: 1 });

module.exports = mongoose.model('ObjectiveOutcome', ObjectiveOutcomeSchema);
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/objectiveOutcomeModel.test.js`
- [ ] **Step 5: Commit** — `git add src/models/ObjectiveOutcome.js src/test/readiness/objectiveOutcomeModel.test.js && git commit -m "feat(readiness): ObjectiveOutcome model (Phase 4A)"`

---

### Task 2: Additive fields on `UserObjective` + `ReadinessProof`

**Files:** Modify `src/models/UserObjective.js`, `src/models/ReadinessProof.js`; Test `src/test/readiness/outcomeAdditiveFields.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const UserObjective = require('../../models/UserObjective');
const ReadinessProof = require('../../models/ReadinessProof');

test('UserObjective.outcomePrompt + ReadinessProof.achieved exist with defaults', () => {
  const o = new UserObjective({ userId: new mongoose.Types.ObjectId(), objectiveType: 'upskilling' });
  o.outcomePrompt = { due: true, lastAskedAt: new Date() };
  assert.equal(o.outcomePrompt.due, true);
  const p = new ReadinessProof({ token: 't', userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId() });
  assert.equal(p.achieved, false);
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/outcomeAdditiveFields.test.js`

- [ ] **Step 3: Implement** — in `src/models/UserObjective.js`, after the `readyState` subdoc (Phase 3A), add:

```js
  // --- Outcome prompt (Phase 4A) ---
  outcomePrompt: {
    due: { type: Boolean, default: false },
    lastAskedAt: { type: Date },
    snoozedUntil: { type: Date },
    promptCount: { type: Number, default: 0 },
  },
```

In `src/models/ReadinessProof.js`, add to the top-level schema (after `viewCount`):

```js
    achieved: { type: Boolean, default: false },
    achievedAt: { type: Date },
```
and add to the `snapshot` sub-object:
```js
      achievedLabel: String, // e.g. "✓ ACHIEVED · Jun 2026" for the verify page
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/outcomeAdditiveFields.test.js`
- [ ] **Step 5: Commit** — `git add src/models/UserObjective.js src/models/ReadinessProof.js src/test/readiness/outcomeAdditiveFields.test.js && git commit -m "feat(readiness): outcomePrompt + proof achieved fields (Phase 4A)"`

---

### Task 3: Outcome taxonomy (`outcomeService.optionsFor` + `labelFor`)

**Files:** Create `src/services/readiness/outcomeService.js`; Test `src/test/readiness/outcomeTaxonomy.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { optionsFor, labelFor } = require('../../services/readiness/outcomeService');

test('optionsFor returns objective-aware options with a label mapping', () => {
  const iv = optionsFor('interview_preparation');
  assert.ok(iv.find((o) => o.key === 'got_role'));
  assert.equal(labelFor('interview_preparation', 'got_role'), 'SUCCESS');
  assert.equal(labelFor('interview_preparation', 'still_interviewing'), 'PENDING');
  assert.equal(labelFor('exam_preparation', 'passed'), 'SUCCESS');
  assert.equal(labelFor('upskilling', 'partly'), 'PARTIAL');
  assert.equal(labelFor('something_unknown', 'achieved'), 'SUCCESS'); // default set
});
test('labelFor returns null for an unknown choice', () => {
  assert.equal(labelFor('interview_preparation', 'nonsense'), null);
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/outcomeTaxonomy.test.js`

- [ ] **Step 3: Implement** `src/services/readiness/outcomeService.js` (this task = the taxonomy half; Tasks 4–5 append more):

```js
'use strict';

// Objective-aware outcome options. Each {key,label,maps} → a normalized label.
const SETS = {
  interview: [
    { key: 'got_role', label: 'I got the role', maps: 'SUCCESS' },
    { key: 'different_role', label: 'I got a different role', maps: 'SUCCESS' },
    { key: 'still_interviewing', label: 'Still interviewing', maps: 'PENDING' },
    { key: 'didnt_work_out', label: "It didn't work out", maps: 'NOT_SUCCESS' },
    { key: 'paused', label: 'Paused this goal', maps: 'ABANDONED' },
  ],
  exam: [
    { key: 'passed', label: 'Passed', maps: 'SUCCESS' },
    { key: 'didnt_pass', label: "Didn't pass", maps: 'NOT_SUCCESS' },
    { key: 'not_taken', label: "Haven't taken it yet", maps: 'PENDING' },
  ],
  skill: [
    { key: 'nailed_it', label: 'Nailed it', maps: 'SUCCESS' },
    { key: 'partly', label: 'Partly', maps: 'PARTIAL' },
    { key: 'not_yet', label: 'Not yet', maps: 'PENDING' },
  ],
  generic: [
    { key: 'achieved', label: 'Achieved it', maps: 'SUCCESS' },
    { key: 'somewhat', label: 'Somewhat', maps: 'PARTIAL' },
    { key: 'not_really', label: 'Not really', maps: 'NOT_SUCCESS' },
    { key: 'not_yet', label: 'Not yet', maps: 'PENDING' },
  ],
};
function setKeyFor(objectiveType) {
  switch (objectiveType) {
    case 'interview_preparation':
    case 'career_switch': return 'interview';
    case 'exam_preparation': return 'exam';
    case 'upskilling':
    case 'academic_excellence': return 'skill';
    default: return 'generic';
  }
}
function optionsFor(objectiveType) {
  return SETS[setKeyFor(objectiveType)].map(({ key, label }) => ({ key, label }));
}
function labelFor(objectiveType, rawChoice) {
  const found = SETS[setKeyFor(objectiveType)].find((o) => o.key === rawChoice);
  return found ? found.maps : null;
}

module.exports = { optionsFor, labelFor, setKeyFor };
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/outcomeTaxonomy.test.js`
- [ ] **Step 5: Commit** — `git add src/services/readiness/outcomeService.js src/test/readiness/outcomeTaxonomy.test.js && git commit -m "feat(readiness): outcome taxonomy (Phase 4A)"`

---

### Task 4: `outcomeService.buildContext` (freeze readiness from snapshot history)

**Files:** Modify `src/services/readiness/outcomeService.js`; Test `src/test/readiness/outcomeBuildContext.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('buildContext freezes latest/peak/nearest-target readiness from snapshot history', async () => {
  const ReadinessSnapshot = require('../../models/ReadinessSnapshot');
  const outcomeService = require('../../services/readiness/outcomeService');
  const objId = new mongoose.Types.ObjectId();
  const target = new Date('2026-06-01');
  const snaps = [
    { value: 70, createdAt: new Date('2026-04-01'), shadow: { coverage: 0.6 } },
    { value: 86, createdAt: new Date('2026-05-20'), shadow: { coverage: 0.74 } }, // peak
    { value: 82, createdAt: new Date('2026-06-02'), shadow: { coverage: 0.75 } }, // latest + nearest target
  ];
  const orig = ReadinessSnapshot.find;
  ReadinessSnapshot.find = () => ({ sort: () => ({ lean: async () => [...snaps].reverse() } ) }); // newest-first
  try {
    const objective = { _id: objId, userId: new mongoose.Types.ObjectId(), objectiveType: 'upskilling',
      target: 80, targetDate: target, readyState: { isReady: true }, createdAt: new Date('2026-02-22') };
    const ctx = await outcomeService.buildContext(objective);
    assert.equal(ctx.readinessAtCapture, 82); // latest
    assert.equal(ctx.peakReadiness, 86);
    assert.equal(ctx.readinessAtTarget, 82); // nearest 2026-06-02 to target 2026-06-01
    assert.equal(ctx.wasEverReady, true);
    assert.equal(ctx.targetAtCapture, 80);
    assert.ok(ctx.weeksToOutcome >= 1);
  } finally { ReadinessSnapshot.find = orig; }
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/outcomeBuildContext.test.js`

- [ ] **Step 3: Implement** — append to `outcomeService.js` and extend exports:

```js
const ReadinessSnapshot = require('../../models/ReadinessSnapshot');
const { getEffectiveTarget, targetBands } = require('./targetService');

function _bandFor(score, bands) {
  if (score >= bands.exceptional) return 'Exceptional';
  if (score >= bands.strong) return 'Strong';
  if (score >= bands.competitive) return 'Competitive';
  return 'Developing';
}

async function buildContext(objective) {
  const snaps = await ReadinessSnapshot.find({ userId: objective.userId, objectiveId: objective._id })
    .sort({ createdAt: -1 }).lean(); // newest-first
  const latest = snaps[0] || null;
  const readinessAtCapture = latest ? latest.value : null;
  const peakReadiness = snaps.length ? Math.max(...snaps.map((s) => s.value || 0)) : null;
  let readinessAtTarget = null;
  if (objective.targetDate && snaps.length) {
    const t = new Date(objective.targetDate).getTime();
    readinessAtTarget = snaps.reduce((best, s) =>
      Math.abs(new Date(s.createdAt).getTime() - t) < Math.abs(new Date(best.createdAt).getTime() - t) ? s : best
    , snaps[0]).value;
  }
  const target = getEffectiveTarget(objective);
  const bands = targetBands(target);
  return {
    readinessAtCapture,
    targetAtCapture: target,
    bandAtCapture: readinessAtCapture != null ? _bandFor(readinessAtCapture, bands) : null,
    readinessAtTarget,
    peakReadiness,
    wasEverReady: !!objective.readyState?.isReady,
    coverageAtCapture: latest?.shadow?.coverage != null ? latest.shadow.coverage : null,
    weeksToOutcome: objective.createdAt
      ? Math.max(1, Math.round((Date.now() - new Date(objective.createdAt)) / (7 * 24 * 3600 * 1000))) : null,
  };
}

module.exports.buildContext = buildContext;
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/outcomeBuildContext.test.js`
- [ ] **Step 5: Commit** — `git add src/services/readiness/outcomeService.js src/test/readiness/outcomeBuildContext.test.js && git commit -m "feat(readiness): freeze readiness context for outcomes (Phase 4A)"`

---

### Task 5: `outcomeService.recordOutcome` + `isDue`

**Files:** Modify `src/services/readiness/outcomeService.js`; Test `src/test/readiness/outcomeRecord.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('recordOutcome: SUCCESS marks objective + stamps proof; isDue respects targetDate/resolved/snooze', async () => {
  const UserObjective = require('../../models/UserObjective');
  const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
  const ReadinessProof = require('../../models/ReadinessProof');
  const outcomeService = require('../../services/readiness/outcomeService');

  const userId = new mongoose.Types.ObjectId();
  const objId = new mongoose.Types.ObjectId();
  const obj = { _id: objId, userId, objectiveType: 'interview_preparation', targetDate: new Date('2020-01-01'),
    status: 'active', readyState: { isReady: true }, createdAt: new Date('2025-01-01'),
    save: async function () { return this; } };
  const o1 = UserObjective.findOne; UserObjective.findOne = () => ({ lean: async () => obj });
  // also non-lean fetch used to mutate+save:
  const o1b = UserObjective.findById; UserObjective.findById = () => obj;
  outcomeService.buildContext = async () => ({ readinessAtCapture: 84 });
  const created = []; const oc = ObjectiveOutcome.create; ObjectiveOutcome.create = async (d) => { created.push(d); return d; };
  const stamped = []; const rp = ReadinessProof.updateMany; ReadinessProof.updateMany = async (q, u) => { stamped.push({ q, u }); return { matchedCount: 1 }; };
  try {
    const out = await outcomeService.recordOutcome(userId, { objectiveId: objId, rawChoice: 'got_role', source: 'i_got_it' });
    assert.equal(out.label, 'SUCCESS');
    assert.equal(out.celebrate, true);
    assert.equal(created[0].label, 'SUCCESS');
    assert.equal(stamped[0].u.$set.achieved, true); // proof stamped
    assert.equal(obj.status, 'completed');           // objective marked

    // isDue: targetDate in the past (2020) + no resolved outcome + not snoozed => due
    assert.equal(outcomeService.isDue({ targetDate: new Date('2020-01-01'), outcomePrompt: {} }, false), true);
    assert.equal(outcomeService.isDue({ targetDate: new Date('2099-01-01'), outcomePrompt: {} }, false), false); // future
    assert.equal(outcomeService.isDue({ targetDate: new Date('2020-01-01'), outcomePrompt: {} }, true), false);  // already resolved
  } finally {
    UserObjective.findOne = o1; UserObjective.findById = o1b; ObjectiveOutcome.create = oc; ReadinessProof.updateMany = rp;
  }
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/outcomeRecord.test.js`

- [ ] **Step 3: Implement** — append to `outcomeService.js`:

```js
const UserObjective = require('../../models/UserObjective');
const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
const ReadinessProof = require('../../models/ReadinessProof');

const REPROMPT_DAYS = 21;
const MAX_PROMPTS = 3;

/** Should we ask for the outcome? True iff targetDate passed, not already resolved,
 *  not snoozed, and under the prompt cap. */
function isDue(objective, hasResolvedOutcome) {
  if (!objective || hasResolvedOutcome) return false;
  if (!objective.targetDate || new Date(objective.targetDate) > new Date()) return false;
  const p = objective.outcomePrompt || {};
  if (p.snoozedUntil && new Date(p.snoozedUntil) > new Date()) return false;
  if ((p.promptCount || 0) >= MAX_PROMPTS) return false;
  return true;
}

async function recordOutcome(userId, { objectiveId, rawChoice, detail, testimonial, allowTestimonialUse, source }) {
  const objective = await UserObjective.findById(objectiveId);
  if (!objective || String(objective.userId) !== String(userId)) throw new Error('OBJECTIVE_NOT_FOUND');
  const label = module.exports.labelFor(objective.objectiveType, rawChoice);
  if (!label) throw new Error('BAD_CHOICE');
  const context = await module.exports.buildContext(objective);

  await ObjectiveOutcome.create({
    userId, objectiveId, objectiveType: objective.objectiveType, label, rawChoice, detail,
    source: source || 'i_got_it', context, testimonial, allowTestimonialUse: !!allowTestimonialUse,
    resolved: label !== 'PENDING', respondedAt: new Date(),
  });

  // Clear the prompt; record the ask.
  objective.outcomePrompt = objective.outcomePrompt || {};
  objective.outcomePrompt.due = false;
  objective.outcomePrompt.lastAskedAt = new Date();
  if (label === 'SUCCESS') { objective.status = 'completed'; objective.completedAt = new Date(); }
  else if (label === 'ABANDONED') { objective.status = 'abandoned'; }
  await objective.save();

  if (label === 'SUCCESS') {
    const stamp = `✓ ACHIEVED · ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
    await ReadinessProof.updateMany(
      { userId, objectiveId, active: true },
      { $set: { achieved: true, achievedAt: new Date(), 'snapshot.achievedLabel': stamp } }
    ).catch(() => {});
  }
  return { ok: true, label, celebrate: label === 'SUCCESS' };
}

module.exports.isDue = isDue;
module.exports.recordOutcome = recordOutcome;
module.exports.REPROMPT_DAYS = REPROMPT_DAYS;
module.exports.MAX_PROMPTS = MAX_PROMPTS;
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/outcomeRecord.test.js`
- [ ] **Step 5: Commit** — `git add src/services/readiness/outcomeService.js src/test/readiness/outcomeRecord.test.js && git commit -m "feat(readiness): recordOutcome + isDue (Phase 4A)"`

---

### Task 6: Routes + `outcomePrompt` block

**Files:** Modify `src/routes/v2/you.js`, `src/routes/v2/plan.js`

- [ ] **Step 1: Add the routes** to `src/routes/v2/you.js` (near `/proof/*`):

```js
router.post('/outcome', auth, async (req, res) => {
  try {
    const out = await require('../../services/readiness/outcomeService').recordOutcome(req.user.userId, req.body || {});
    require('../../services/diagnosticTelemetryService').logEvent('outcome.recorded', { userId: String(req.user.userId), label: out.label });
    res.json({ success: true, data: out });
  } catch (err) {
    const code = ['OBJECTIVE_NOT_FOUND', 'BAD_CHOICE'].includes(err.message) ? 400 : 500;
    if (code === 500) console.error('[v2/you/outcome]', err.message);
    res.status(code).json({ success: false, message: code === 400 ? err.message : 'Could not record outcome.' });
  }
});
router.post('/outcome/snooze', auth, async (req, res) => {
  try {
    const UserObjective = require('../../models/UserObjective');
    await UserObjective.updateOne(
      { userId: req.user.userId, status: 'active', isPrimary: true },
      { $set: { 'outcomePrompt.snoozedUntil': new Date(Date.now() + 14 * 864e5), 'outcomePrompt.due': false }, $inc: { 'outcomePrompt.promptCount': 1 } }
    );
    res.json({ success: true, data: { ok: true } });
  } catch (err) { res.status(500).json({ success: false, message: 'Could not snooze.' }); }
});
```

- [ ] **Step 2: Add the `outcomePrompt` block to `/you/overview`.** After the ready-block detection (Phase 3A), add (it lazily marks due + builds the prompt payload):

```js
    // Phase 4A — outcome prompt (lazy "target date passed" check).
    let outcomePrompt = null;
    try {
      if (objective) {
        const outcomeService = require('../../services/readiness/outcomeService');
        const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
        const resolved = await ObjectiveOutcome.exists({ userId, objectiveId: objective._id, resolved: true });
        if (outcomeService.isDue(objective, !!resolved)) {
          outcomePrompt = {
            due: true, objectiveId: String(objective._id), objectiveLabel: buildObjectiveLabel(objective),
            readiness: servedReadiness, options: outcomeService.optionsFor(objective.objectiveType),
          };
          // best-effort: mark due + bump prompt count so cadence/cap apply
          UserObjective.updateOne({ _id: objective._id }, { $set: { 'outcomePrompt.due': true, 'outcomePrompt.lastAskedAt': new Date() }, $inc: { 'outcomePrompt.promptCount': 1 } }).catch(() => {});
        }
      }
    } catch (e) { console.warn('[v2/you/overview] outcome prompt skipped:', e.message); }
```
and add `outcomePrompt` to the response `data` (top level, next to `readiness`).

- [ ] **Step 3: Add a read-only `outcomePrompt` to `/plan/today`** in `src/routes/v2/plan.js` (mirror, but do NOT bump promptCount there — overview owns the cadence; plan/today just surfaces if already due):

```js
    let outcomePrompt = null;
    if (objective?.outcomePrompt?.due) {
      const outcomeService = require('../../services/readiness/outcomeService');
      outcomePrompt = { due: true, objectiveId: String(objective._id),
        objectiveLabel: (objective.specifics?.targetRole || objective.objectiveType),
        options: outcomeService.optionsFor(objective.objectiveType) };
    }
```
and include `outcomePrompt` in each `/today` response payload (next to `ready`).

- [ ] **Step 4: Verify parse** — `node --check src/routes/v2/you.js && node --check src/routes/v2/plan.js`
- [ ] **Step 5: Commit** — `git add src/routes/v2/you.js src/routes/v2/plan.js && git commit -m "feat(readiness): POST /you/outcome + outcomePrompt block (Phase 4A)"`

---

### Task 7: Run suite + push

- [ ] **Step 1:** `for f in src/test/readiness/outcome*.test.js src/test/readiness/objectiveOutcomeModel.test.js; do echo "## $f"; node "$f" 2>&1 | grep -E "# (tests|pass|fail)"; done` — all `# fail 0`.
- [ ] **Step 2:** `node --check src/routes/v2/you.js && node --check src/routes/v2/plan.js && echo OK`
- [ ] **Step 3:** `git push origin master`

---

# PHASE B — iOS (`ScaleUpDemo-f`)

### Task 8: iOS model + `V2OutcomeSheet`

**Files:** Modify `ScaleUp/Features/V2/Home/V2HomeViewModel.swift`; Create `ScaleUp/Features/V2/Home/V2OutcomeSheet.swift`

- [ ] **Step 1: Add `outcomePrompt` to `V2HomeData`** (mirror the 3A `ready` pattern — `var` + default so it decodes + doesn't break `sampleData`):

```swift
    var outcomePrompt: OutcomePrompt? = nil
    struct OutcomePrompt: Codable {
        let due: Bool
        let objectiveId: String
        let objectiveLabel: String?
        let options: [Option]
        struct Option: Codable, Identifiable { let key: String; let label: String; var id: String { key } }
    }
```

- [ ] **Step 2: Create `V2OutcomeSheet.swift`**

```swift
import SwiftUI

/// "How did it go?" — Phase 4A outcome capture. Server-provided objective-aware
/// options; SUCCESS triggers a celebration + (server-side) stamps the proof.
struct V2OutcomeSheet: View {
    let prompt: V2HomeData.OutcomePrompt
    let onDone: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var submitting = false
    @State private var celebrate = false

    var body: some View {
        NavigationStack {
            ScrollView {
                if celebrate {
                    VStack(spacing: 12) {
                        Text("🎉").font(.system(size: 48))
                        Text("You did it!").font(.system(size: 22, weight: .heavy)).foregroundStyle(ColorTokens.gold)
                        Text("Your proof now shows ✓ ACHIEVED.").font(.system(size: 13)).foregroundStyle(ColorTokens.textSecondary)
                        Button("Done") { onDone(); dismiss() }
                            .font(.system(size: 15, weight: .semibold)).foregroundStyle(ColorTokens.background)
                            .frame(maxWidth: .infinity).padding(.vertical, 13).background(ColorTokens.gold)
                            .clipShape(RoundedRectangle(cornerRadius: 12)).padding(.top, 8)
                    }.padding(24)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Text((prompt.objectiveLabel ?? "Your goal").uppercased())
                            .font(.system(size: 10, weight: .bold)).tracking(1.2).foregroundStyle(ColorTokens.gold)
                        Text("How did it go?").font(.system(size: 20, weight: .bold)).foregroundStyle(ColorTokens.textPrimary)
                            .padding(.bottom, 6)
                        ForEach(prompt.options) { opt in
                            Button { submit(opt.key) } label: {
                                Text(opt.label).font(.system(size: 15, weight: .medium)).foregroundStyle(ColorTokens.textPrimary)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                                    .background(RoundedRectangle(cornerRadius: 12).fill(ColorTokens.surface))
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(ColorTokens.surfaceElevated.opacity(0.7), lineWidth: 1))
                            }.buttonStyle(.plain).disabled(submitting)
                        }
                    }.padding(20)
                }
            }
            .background(ColorTokens.background.ignoresSafeArea())
            .navigationTitle("Your outcome").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button("Later") { Task { try? await V2APIClient.shared.post("/you/outcome/snooze", body: OutcomeEmpty()) }; dismiss() }
                    .foregroundStyle(ColorTokens.textTertiary) } }
        }
    }

    private struct OutcomeEmpty: Codable {}
    private struct OutcomeBody: Codable { let objectiveId: String; let rawChoice: String; let source: String }
    private struct OutcomeResp: Codable { let label: String; let celebrate: Bool }

    private func submit(_ rawChoice: String) {
        submitting = true
        Task {
            do {
                let r: V2APIResponse<OutcomeResp> = try await V2APIClient.shared.post(
                    "/you/outcome", body: OutcomeBody(objectiveId: prompt.objectiveId, rawChoice: rawChoice, source: "target_date_prompt"))
                if r.data.celebrate { celebrate = true } else { onDone(); dismiss() }
            } catch { dismiss() }
            submitting = false
        }
    }
}
```

- [ ] **Step 3: Commit** — `git add ScaleUp/Features/V2/Home/V2HomeViewModel.swift ScaleUp/Features/V2/Home/V2OutcomeSheet.swift && git commit -m "feat(readiness/ios): outcome capture sheet (Phase 4A)"`

---

### Task 9: iOS — surface the sheet on Home + "I got it!"

**Files:** Modify `ScaleUp/Features/V2/Home/V2HomeView.swift`

- [ ] **Step 1: Add state** near the other `@State`:

```swift
    @State private var showOutcome = false
    @State private var outcomeShownThisSession = false
```

- [ ] **Step 2: Auto-present when due** (once per session). Add to the root view:

```swift
        .onChange(of: vm.data?.outcomePrompt?.due) { _, due in
            if due == true && !outcomeShownThisSession { outcomeShownThisSession = true; showOutcome = true }
        }
        .sheet(isPresented: $showOutcome) {
            if let p = vm.data?.outcomePrompt {
                V2OutcomeSheet(prompt: p, onDone: { Task { await vm.load() } })
            }
        }
```

- [ ] **Step 3: Add an always-on "I got it!" affordance.** In the readiness status-bar area, add a small button (only meaningful when there's an objective). It opens the same sheet, building a prompt from the current objective if `outcomePrompt` is nil isn't possible client-side — so the button is shown only when `vm.data?.outcomePrompt != nil` OR (simpler for v1) gate it behind the server prompt. Minimal v1: surface the "I got it!" text-button only when `outcomePrompt?.due == true` is false but the user wants to self-report — since the server builds options, the button triggers a tiny fetch. **v1 decision: show "I got it! 🎉" as a small button under the status bar that sets `showOutcome = true` only if `vm.data?.outcomePrompt != nil`; otherwise hide it.** (A future iteration can add a dedicated GET to build the prompt on demand.)

```swift
                if vm.data?.outcomePrompt != nil {
                    Button("I got it! 🎉") { showOutcome = true }
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(ColorTokens.gold)
                }
```

- [ ] **Step 4: Commit** — `git add ScaleUp/Features/V2/Home/V2HomeView.swift && git commit -m "feat(readiness/ios): surface outcome prompt + I-got-it (Phase 4A)"`

---

### Task 10: iOS build 184 → TestFlight

- [ ] **Step 1:** bump `project.yml` `CURRENT_PROJECT_VERSION` to `184`; `/opt/homebrew/Cellar/xcodegen/2.45.3/bin/xcodegen generate`; confirm `grep -c "V2OutcomeSheet.swift" ScaleUp.xcodeproj/project.pbxproj` ≥ 2; commit `project.yml` + `ScaleUp.xcodeproj/project.pbxproj`.
- [ ] **Step 2: Archive** (clean; API-key signing):
```bash
rm -rf ~/Library/Developer/Xcode/DerivedData/ScaleUp-* build/ScaleUp.xcarchive
xcodebuild -project ScaleUp.xcodeproj -scheme ScaleUp -configuration Release -archivePath build/ScaleUp.xcarchive \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  -authenticationKeyPath /Users/nirpekshnandan/.private_keys/AuthKey_A4MNMMCCVB.p8 \
  -authenticationKeyID A4MNMMCCVB -authenticationKeyIssuerID 0bbf6f7f-a7cf-4b88-8759-4c85e5c0f240 clean archive
```
- [ ] **Step 3: Export + upload** (same auth flags + `-exportOptionsPlist ExportOptions.plist`). Expected `Upload succeeded`.
- [ ] **Step 4:** `git push origin master`

---

# PHASE C — Android (`ScaleUpDemo-f-Android`)

### Task 11: Android — outcome sheet + surface

**Files:** Create `src/features/v2/screens/V2OutcomeSheet.tsx`; Modify `src/features/v2/screens/V2HomeScreen.tsx`

- [ ] **Step 1: Add the `outcomePrompt` type** to the Home `HomeData` interface in `V2HomeScreen.tsx`:

```typescript
  outcomePrompt?: {
    due: boolean
    objectiveId: string
    objectiveLabel?: string
    options: Array<{ key: string; label: string }>
  } | null
```

- [ ] **Step 2: Create `src/features/v2/screens/V2OutcomeSheet.tsx`**

```tsx
import React, { useState } from 'react'
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { V2Api } from '../api/v2Client'
import { V2Colors, V2Type, V2Spacing } from '../core/V2Theme'

type Prompt = { objectiveId: string; objectiveLabel?: string; options: Array<{ key: string; label: string }> }
export const V2OutcomeSheet: React.FC<{ prompt: Prompt; onDone: () => void; onClose: () => void }> = ({ prompt, onDone, onClose }) => {
  const [busy, setBusy] = useState(false)
  const [celebrate, setCelebrate] = useState(false)
  const submit = async (rawChoice: string) => {
    setBusy(true)
    try {
      const res = await V2Api.post<{ label: string; celebrate: boolean }>('/you/outcome',
        { objectiveId: prompt.objectiveId, rawChoice, source: 'target_date_prompt' })
      if (res.data?.celebrate) setCelebrate(true)
      else { onDone(); onClose() }
    } catch { onClose() }
    setBusy(false)
  }
  const snooze = async () => { try { await V2Api.post('/you/outcome/snooze', {}) } catch {} ; onClose() }
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: V2Colors.background }} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={snooze}><Text style={{ color: V2Colors.textTertiary }}>Later</Text></Pressable>
        <Text style={[V2Type.h3, { color: V2Colors.textPrimary }]}>Your outcome</Text>
        <View style={{ width: 40 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: V2Spacing.pad }}>
        {celebrate ? (
          <View style={{ alignItems: 'center', paddingTop: 30 }}>
            <Text style={{ fontSize: 48 }}>🎉</Text>
            <Text style={{ color: V2Colors.gold, fontSize: 22, fontWeight: '800' }}>You did it!</Text>
            <Text style={[V2Type.small, { color: V2Colors.textSecondary, marginTop: 6 }]}>Your proof now shows ✓ ACHIEVED.</Text>
            <Pressable style={styles.cta} onPress={() => { onDone(); onClose() }}><Text style={styles.ctaTxt}>Done</Text></Pressable>
          </View>
        ) : (
          <>
            <Text style={styles.eyebrow}>{(prompt.objectiveLabel ?? 'YOUR GOAL').toUpperCase()}</Text>
            <Text style={[V2Type.h2, { color: V2Colors.textPrimary, marginBottom: 12 }]}>How did it go?</Text>
            {prompt.options.map((o) => (
              <Pressable key={o.key} style={styles.opt} disabled={busy} onPress={() => submit(o.key)}>
                <Text style={[V2Type.bodyMedium, { color: V2Colors.textPrimary }]}>{o.label}</Text>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: V2Spacing.pad, borderBottomWidth: 1, borderBottomColor: V2Colors.cardBorder },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, color: V2Colors.gold, marginBottom: 4 },
  opt: { backgroundColor: V2Colors.surface, borderColor: V2Colors.cardBorder, borderWidth: 1, borderRadius: V2Spacing.cardRadius, padding: 16, marginBottom: 10 },
  cta: { backgroundColor: V2Colors.gold, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 40, marginTop: 14 },
  ctaTxt: { color: V2Colors.background, fontWeight: '700' },
})
```

- [ ] **Step 3: Wire into `V2HomeScreen.tsx`** — state + a page-sheet Modal that auto-opens when due (once per session) + an "I got it!" affordance:

```tsx
import { V2OutcomeSheet } from './V2OutcomeSheet'
// state:
const [showOutcome, setShowOutcome] = useState(false)
const [outcomeShown, setOutcomeShown] = useState(false)
// effect: when data loads with a due prompt, open once
useEffect(() => {
  if (data?.outcomePrompt?.due && !outcomeShown) { setOutcomeShown(true); setShowOutcome(true) }
}, [data?.outcomePrompt?.due, outcomeShown])
// modal (alongside other modals):
<Modal visible={showOutcome} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowOutcome(false)}>
  {data?.outcomePrompt && (
    <V2OutcomeSheet prompt={data.outcomePrompt} onDone={() => void load()} onClose={() => setShowOutcome(false)} />
  )}
</Modal>
// "I got it!" affordance near the readiness bar (only when a prompt exists):
{data?.outcomePrompt && (
  <Pressable onPress={() => setShowOutcome(true)}><Text style={{ color: V2Colors.gold, fontWeight: '600', fontSize: 12 }}>I got it! 🎉</Text></Pressable>
)}
```
(`useEffect` is imported from React; confirm `import React, { useEffect, ... }`.)

- [ ] **Step 4: Typecheck** — `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "V2HomeScreen|V2OutcomeSheet" || echo clean` (only your files must be clean).
- [ ] **Step 5: Commit + push** — `git add src/features/v2/screens/V2OutcomeSheet.tsx src/features/v2/screens/V2HomeScreen.tsx && git commit -m "feat(readiness/android): outcome capture sheet + surface (Phase 4A)" && git push origin main`

---

## Self-Review (by plan author)

**Spec coverage:** ObjectiveOutcome + frozen context → T1/T4; additive fields → T2; taxonomy → T3; recordOutcome (mark objective + stamp proof) → T5; isDue/cadence/cap → T5; routes + outcomePrompt block (overview + today) → T6; iOS sheet+surface+build → T8–10; Android → T11; proof "✓ ACHIEVED" stamp → T5; target-date lazy check → T6. 4B explicitly NOT built.

**Flagged planning decisions (explicit, not placeholders):** (a) "I got it!" is shown only when the server already provides an `outcomePrompt` in v1 (no dedicated build-prompt-on-demand GET) — a future iteration can add one so users can self-report a win before the target date; noted in T9/T11. (b) overview owns the prompt cadence/cap (bumps promptCount); /plan/today only mirrors an already-due prompt. (c) snooze targets the primary active objective. (d) iOS `V2APIResponse`/`V2APIClient.shared.post` + Android `V2Api.post` signatures are reused-existing — match the real ones (grep) as in 3A/3B.

**Out of scope:** PART 4B (calibration model), recruiter verification, testimonial moderation UI.
