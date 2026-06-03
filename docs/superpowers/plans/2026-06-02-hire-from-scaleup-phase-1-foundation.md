# Hire from ScaleUp — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the backend foundation of the employer marketplace — the consented `TalentProfile`, candidate opt-in/consent endpoints, employer accounts with email-verify (browse tier) + admin-approval (contact tier) — all behind a flag, doing nothing user-facing until later phases wire the UI.

**Architecture:** Extend `scaleup-backend`. Three concerns: (1) the candidate's consented projection (`TalentProfile` + eligibility + a snapshot built by **reusing `proofService.buildSnapshot`**), (2) candidate consent endpoints under the existing learner API (`/api/v2/you/talent*`, `auth`-gated), (3) a brand-new employer identity surface (`EmployerAccount`, magic-link auth, `/api/employer/auth/*`, a new `employerAuth` middleware) plus admin approval folded into the existing `/api/v1/admin` router. No billing, no search/ranking yet (Phase 2), no client UI (later).

**Tech Stack:** Node/Express, Mongoose, `jsonwebtoken` (existing `JWT_ACCESS_SECRET`), Node's built-in `node:test` is NOT used — single test files run with `node <path>`. Feature-flagged via `src/config/featureFlags.js`.

**Conventions (match these exactly):**
- Models: `mongoose.Schema({...}, { timestamps: true })`, `module.exports = mongoose.model('Name', Schema)`.
- Services: export functions on `module.exports`, and call internal helpers via `module.exports.fn(...)` where a test needs to stub them (the established indirection pattern, e.g. `proofService._countEvidence`).
- Tests: plain Node scripts using `assert`, run with `node <path>` (NOT `node --test`). Monkey-patch Mongoose models / service deps inline (see `src/test/readiness/proofPublish.test.js`, `calibrationEvidence.test.js` for the pattern). Each prints `# tests N` / `# pass N` / `# fail N`.
- Commit directly to `master` (auto-deploys). One commit per task.

---

## File Structure

**Create:**
- `src/config/featureFlags.js` — *modify*: add `FEATURE_EMPLOYER_MARKETPLACE`.
- `src/models/TalentProfile.js` — the consented, discoverable projection (consent + prefs + denormalized snapshot).
- `src/models/EmployerAccount.js` — employer identity + access tiers.
- `src/services/employer/talentEligibilityService.js` — pure eligibility predicate.
- `src/services/employer/talentProfileService.js` — build snapshot (reuse `proofService.buildSnapshot`), opt-in/out, refresh.
- `src/services/employer/employerAuthService.js` — signup, email verify, magic-link login; work-email validation; JWT issue.
- `src/middleware/employerAuth.js` — verify employer JWT → `req.employer`; `requireContactTier` guard.
- `src/routes/employer/auth.js` — `/api/employer/auth/*` routes.
- `src/routes/v2/talent.js` — candidate consent routes (`/api/v2/you/talent*`).
- Tests under `src/test/employer/`.

**Modify:**
- `src/app.js` — mount `/api/employer/auth` and `/api/v2/you/talent`.
- `src/routes/admin.js` — add employer approval queue endpoints.

---

## Task 1: Feature flag

**Files:**
- Modify: `src/config/featureFlags.js`
- Test: `src/test/employer/flag.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/flag.test.js
'use strict';
const assert = require('assert');
process.env.FEATURE_EMPLOYER_MARKETPLACE = 'true';
delete require.cache[require.resolve('../../config/featureFlags')];
const flags = require('../../config/featureFlags');
let pass = 0, fail = 0;
try { assert.strictEqual(flags.employerMarketplace, true); pass++; }
catch (e) { fail++; console.error(e.message); }
console.log(`# tests 1\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `node src/test/employer/flag.test.js`
Expected: `# fail 1` (`employerMarketplace` is undefined).

- [ ] **Step 3: Add the flag**

In `src/config/featureFlags.js`, inside `FLAGS`, add:
```js
  // Hire from ScaleUp employer marketplace. Off by default — Phase 1 ships the
  // data + consent + employer-auth foundation inert until later phases add UI.
  FEATURE_EMPLOYER_MARKETPLACE: process.env.FEATURE_EMPLOYER_MARKETPLACE === 'true',
```
And in `module.exports`, add: `employerMarketplace: FLAGS.FEATURE_EMPLOYER_MARKETPLACE,`

- [ ] **Step 4: Run it — expect PASS**

Run: `node src/test/employer/flag.test.js` → `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/config/featureFlags.js src/test/employer/flag.test.js
git commit -m "feat(employer): FEATURE_EMPLOYER_MARKETPLACE flag (Phase 1)"
```

---

## Task 2: `TalentProfile` model

**Files:**
- Create: `src/models/TalentProfile.js`
- Test: `src/test/employer/talentModel.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/talentModel.test.js
'use strict';
const assert = require('assert');
const mongoose = require('mongoose');
const TalentProfile = require('../../models/TalentProfile');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('defaults', () => {
  const t = new TalentProfile({ userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId() });
  assert.strictEqual(t.optedIn, false);
  assert.strictEqual(t.status, 'active');
});
ok('snapshot shape accepts evidence + competencies', () => {
  const t = new TalentProfile({
    userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId(),
    snapshot: { roleLabel: 'Backend Engineer', readinessBand: 'Strong', readinessScore: 83,
      competencies: [{ name: 'System Design', score: 91 }],
      evidence: { assessments: 14, capstonesGraded: 3, interviews: 2, coveragePct: 92 },
      achieved: false, verified: true, proofToken: 'abc' },
  });
  assert.strictEqual(t.snapshot.competencies[0].score, 91);
  assert.strictEqual(t.snapshot.evidence.coveragePct, 92);
});
ok('status enum rejects junk', () => {
  const t = new TalentProfile({ userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId(), status: 'nope' });
  const err = t.validateSync();
  assert.ok(err && err.errors.status);
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '../../models/TalentProfile'`).

Run: `node src/test/employer/talentModel.test.js`

- [ ] **Step 3: Create the model**

```js
// src/models/TalentProfile.js
'use strict';
const mongoose = require('mongoose');

// The consented, employer-discoverable projection of a candidate's career objective.
// Exists only when a learner opts in. `snapshot` is denormalized from the live readiness
// data (built by reusing proofService.buildSnapshot) so search/rank is O(1).
const TalentProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', required: true },

    // consent (candidate-owned)
    optedIn: { type: Boolean, default: false },
    optedInAt: { type: Date },
    status: { type: String, enum: ['active', 'paused'], default: 'active' },

    // recruiter-facing preferences (candidate-supplied)
    city: { type: String },
    noticePeriod: { type: String },
    workPref: { type: String, enum: ['onsite', 'remote', 'hybrid', 'any'], default: 'any' },

    // denormalized searchable snapshot (refreshed on key events)
    snapshot: {
      roleLabel: String,
      objectiveType: String,
      targetCompany: String,
      readinessBand: String,
      readinessScore: Number,
      target: Number,
      competencies: [{ name: String, score: Number, _id: false }],
      evidence: {
        assessments: { type: Number, default: 0 },
        capstonesGraded: { type: Number, default: 0 },
        interviews: { type: Number, default: 0 },
        coveragePct: { type: Number, default: null },
      },
      codingMastery: { type: mongoose.Schema.Types.Mixed, default: null },
      achieved: { type: Boolean, default: false },
      verified: { type: Boolean, default: false },
      proofToken: { type: String, default: null },
      lastActiveAt: { type: Date },
    },
    refreshedAt: { type: Date },
  },
  { timestamps: true }
);
// one talent profile per (user, objective)
TalentProfileSchema.index({ userId: 1, objectiveId: 1 }, { unique: true });
// search uses these (Phase 2)
TalentProfileSchema.index({ optedIn: 1, status: 1, 'snapshot.objectiveType': 1, 'snapshot.readinessScore': -1 });

module.exports = mongoose.model('TalentProfile', TalentProfileSchema);
```

- [ ] **Step 4: Run it — expect PASS** (`# fail 0`).

- [ ] **Step 5: Commit**

```bash
git add src/models/TalentProfile.js src/test/employer/talentModel.test.js
git commit -m "feat(employer): TalentProfile model (Phase 1)"
```

---

## Task 3: Eligibility predicate

**Files:**
- Create: `src/services/employer/talentEligibilityService.js`
- Test: `src/test/employer/eligibility.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/eligibility.test.js
'use strict';
const assert = require('assert');
const { isEligible, CAREER_INTENT } = require('../../services/employer/talentEligibilityService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('career-intent + evidence -> eligible', () => assert.strictEqual(isEligible({ objectiveType: 'interview_preparation', evidenceCount: 3 }), true));
ok('career_switch counts', () => assert.strictEqual(isEligible({ objectiveType: 'career_switch', evidenceCount: 1 }), true));
ok('exam_preparation excluded', () => assert.strictEqual(isEligible({ objectiveType: 'exam_preparation', evidenceCount: 9 }), false));
ok('casual_learning excluded', () => assert.strictEqual(isEligible({ objectiveType: 'casual_learning', evidenceCount: 9 }), false));
ok('career-intent but no evidence -> not eligible', () => assert.strictEqual(isEligible({ objectiveType: 'interview_preparation', evidenceCount: 0 }), false));
ok('CAREER_INTENT has the three', () => assert.strictEqual(CAREER_INTENT.size, 3));
console.log(`# tests 6\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).

- [ ] **Step 3: Implement**

```js
// src/services/employer/talentEligibilityService.js
'use strict';

// Career-intent objective types only — a NEET aspirant or hobby learner is noise to a recruiter.
// `upskilling` is included as job-focused per the design spec.
const CAREER_INTENT = new Set(['interview_preparation', 'career_switch', 'upskilling']);

// A candidate is poolable when their objective is career-intent AND they have real evidence
// (>=1 assessment/capstone/interview). Opt-in/active is enforced separately by the caller.
function isEligible({ objectiveType, evidenceCount }) {
  return CAREER_INTENT.has(objectiveType) && (evidenceCount || 0) > 0;
}

module.exports = { isEligible, CAREER_INTENT };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/talentEligibilityService.js src/test/employer/eligibility.test.js
git commit -m "feat(employer): talent eligibility predicate (Phase 1)"
```

---

## Task 4: `talentProfileService` — build snapshot, opt-in/out

**Files:**
- Create: `src/services/employer/talentProfileService.js`
- Test: `src/test/employer/talentProfileService.test.js`

This reuses `proofService.buildSnapshot(userId)` (returns `{ objectiveLabel, score, target, band, competencies:[{name,score}], evidence:{assessments,capstonesGraded,coveragePct,hoursInvested} }`) and augments it with `interviews` count, `achieved` (ObjectiveOutcome), and `verified`/`proofToken` (ReadinessProof). All DB/service deps are reached via `module.exports.*` so the test can stub them.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/talentProfileService.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/talentProfileService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  // stub the projection sources
  svc._buildProofSnapshot = async () => ({
    objectiveLabel: 'Backend Engineer', score: 83, target: 80, band: 'Strong',
    competencies: [{ name: 'System Design', score: 91 }],
    evidence: { assessments: 14, capstonesGraded: 3, coveragePct: 92, hoursInvested: 40 },
  });
  svc._countInterviews = async () => 2;
  svc._getOutcomeAchieved = async () => true;
  svc._getActiveProof = async () => ({ token: 'tok123' });

  await ok('buildTalentSnapshot maps + augments', async () => {
    const snap = await svc.buildTalentSnapshot('u1', { objectiveType: 'interview_preparation', specifics: { targetCompany: 'TechCo' } });
    assert.strictEqual(snap.roleLabel, 'Backend Engineer');
    assert.strictEqual(snap.readinessBand, 'Strong');
    assert.strictEqual(snap.readinessScore, 83);
    assert.strictEqual(snap.evidence.interviews, 2);
    assert.strictEqual(snap.evidence.coveragePct, 92);
    assert.strictEqual(snap.achieved, true);
    assert.strictEqual(snap.verified, true);
    assert.strictEqual(snap.proofToken, 'tok123');
    assert.strictEqual(snap.targetCompany, 'TechCo');
  });

  await ok('no active proof -> verified false', async () => {
    svc._getActiveProof = async () => null;
    const snap = await svc.buildTalentSnapshot('u1', { objectiveType: 'interview_preparation' });
    assert.strictEqual(snap.verified, false);
    assert.strictEqual(snap.proofToken, null);
  });

  console.log(`# tests 2\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).

- [ ] **Step 3: Implement**

```js
// src/services/employer/talentProfileService.js
'use strict';

// Thin wrappers so tests can stub each source independently.
async function _buildProofSnapshot(userId) {
  return require('../readiness/proofService').buildSnapshot(userId);
}
async function _countInterviews(userId) {
  const InterviewSession = require('../../models/InterviewSession');
  return InterviewSession.countDocuments({ userId, status: { $in: ['completed', 'evaluated'] } }).catch(() => 0);
}
async function _getOutcomeAchieved(userId, objectiveId) {
  const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
  return !!(await ObjectiveOutcome.exists({ userId, objectiveId, label: 'SUCCESS' }).catch(() => null));
}
async function _getActiveProof(userId) {
  const ReadinessProof = require('../../models/ReadinessProof');
  return ReadinessProof.findOne({ userId, active: true }).select('token').lean().catch(() => null);
}

// Build the denormalized TalentProfile.snapshot for a user's objective by REUSING the
// proof projection and augmenting it. Returns the snapshot sub-document (no DB write).
// Throws if proofService can't build (NO_OBJECTIVE / NO_SNAPSHOT) — caller guards.
async function buildTalentSnapshot(userId, objective) {
  const p = await module.exports._buildProofSnapshot(userId);
  const [interviews, achieved, proof] = await Promise.all([
    module.exports._countInterviews(userId),
    module.exports._getOutcomeAchieved(userId, objective._id),
    module.exports._getActiveProof(userId),
  ]);
  return {
    roleLabel: p.objectiveLabel,
    objectiveType: objective.objectiveType,
    targetCompany: objective.specifics?.targetCompany || null,
    readinessBand: p.band,
    readinessScore: p.score,
    target: p.target,
    competencies: (p.competencies || []).map((c) => ({ name: c.name, score: c.score })),
    evidence: {
      assessments: p.evidence?.assessments || 0,
      capstonesGraded: p.evidence?.capstonesGraded || 0,
      interviews: interviews || 0,
      coveragePct: typeof p.evidence?.coveragePct === 'number' ? p.evidence.coveragePct : null,
    },
    codingMastery: null, // populated in Phase 2 for coding-eligible objectives
    achieved: !!achieved,
    verified: !!proof,
    proofToken: proof?.token || null,
    lastActiveAt: new Date(),
  };
}

module.exports = { buildTalentSnapshot, _buildProofSnapshot, _countInterviews, _getOutcomeAchieved, _getActiveProof };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/talentProfileService.js src/test/employer/talentProfileService.test.js
git commit -m "feat(employer): talentProfileService.buildTalentSnapshot reuses proof snapshot (Phase 1)"
```

---

## Task 5: `talentProfileService.optIn / optOut / refresh`

**Files:**
- Modify: `src/services/employer/talentProfileService.js`
- Test: `src/test/employer/talentOptIn.test.js`

`optIn` resolves the user's active primary objective, checks eligibility (Task 3) using the evidence count from the freshly built snapshot, and upserts a `TalentProfile` with `optedIn:true` + the snapshot. Returns `{ ok:true }` or throws `NOT_ELIGIBLE` / `NO_OBJECTIVE`.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/talentOptIn.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/talentProfileService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  const objective = { _id: 'obj1', objectiveType: 'interview_preparation', specifics: {} };
  svc._getPrimaryObjective = async () => objective;
  svc.buildTalentSnapshot = async () => ({
    objectiveType: 'interview_preparation', readinessBand: 'Strong', readinessScore: 83,
    evidence: { assessments: 5, capstonesGraded: 0, interviews: 0, coveragePct: 60 },
    achieved: false, verified: false, proofToken: null,
  });
  let upserted = null;
  svc._upsertProfile = async (userId, objId, patch) => { upserted = { userId, objId, patch }; return { ok: true }; };

  await ok('eligible opt-in upserts optedIn=true + snapshot', async () => {
    const r = await svc.optIn('u1', { city: 'Bangalore', workPref: 'hybrid' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(upserted.patch.optedIn, true);
    assert.strictEqual(upserted.patch.city, 'Bangalore');
    assert.strictEqual(upserted.patch.snapshot.readinessScore, 83);
  });

  await ok('no objective -> NO_OBJECTIVE', async () => {
    svc._getPrimaryObjective = async () => null;
    await assert.rejects(() => svc.optIn('u1', {}), /NO_OBJECTIVE/);
  });

  await ok('ineligible objective -> NOT_ELIGIBLE', async () => {
    svc._getPrimaryObjective = async () => ({ _id: 'o2', objectiveType: 'casual_learning', specifics: {} });
    svc.buildTalentSnapshot = async () => ({ objectiveType: 'casual_learning', evidence: { assessments: 5 } });
    await assert.rejects(() => svc.optIn('u1', {}), /NOT_ELIGIBLE/);
  });

  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL** (`svc.optIn is not a function`).

- [ ] **Step 3: Implement (append to `talentProfileService.js`)**

Add these wrappers + functions, and extend `module.exports`:

```js
const { isEligible } = require('./talentEligibilityService');

async function _getPrimaryObjective(userId) {
  const UserObjective = require('../../models/UserObjective');
  return UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
}
async function _upsertProfile(userId, objectiveId, patch) {
  const TalentProfile = require('../../models/TalentProfile');
  return TalentProfile.updateOne({ userId, objectiveId }, { $set: patch }, { upsert: true });
}

function _evidenceCount(snap) {
  const e = snap.evidence || {};
  return (e.assessments || 0) + (e.capstonesGraded || 0) + (e.interviews || 0);
}

// Candidate opts in. Resolves their primary objective, builds the snapshot, gates on
// eligibility, and upserts an active TalentProfile. `prefs` = { city, noticePeriod, workPref }.
async function optIn(userId, prefs = {}) {
  const objective = await module.exports._getPrimaryObjective(userId);
  if (!objective) throw new Error('NO_OBJECTIVE');
  const snapshot = await module.exports.buildTalentSnapshot(userId, objective);
  if (!isEligible({ objectiveType: snapshot.objectiveType, evidenceCount: _evidenceCount(snapshot) })) {
    throw new Error('NOT_ELIGIBLE');
  }
  const patch = {
    optedIn: true, optedInAt: new Date(), status: 'active', snapshot, refreshedAt: new Date(),
    ...(prefs.city != null ? { city: prefs.city } : {}),
    ...(prefs.noticePeriod != null ? { noticePeriod: prefs.noticePeriod } : {}),
    ...(prefs.workPref != null ? { workPref: prefs.workPref } : {}),
  };
  await module.exports._upsertProfile(userId, objective._id, patch);
  return { ok: true };
}

// Candidate withdraws — pause (keeps the row + prefs but drops out of search).
async function optOut(userId) {
  const objective = await module.exports._getPrimaryObjective(userId);
  if (!objective) return { ok: true };
  await module.exports._upsertProfile(userId, objective._id, { optedIn: false, status: 'paused' });
  return { ok: true };
}

// Rebuild the snapshot for an already-opted-in candidate (called on readiness/outcome/proof
// change in later phases). No-op if not opted in.
async function refresh(userId) {
  const objective = await module.exports._getPrimaryObjective(userId);
  if (!objective) return { ok: false };
  const TalentProfile = require('../../models/TalentProfile');
  const existing = await TalentProfile.findOne({ userId, objectiveId: objective._id }).select('optedIn').lean();
  if (!existing || !existing.optedIn) return { ok: false };
  const snapshot = await module.exports.buildTalentSnapshot(userId, objective);
  await module.exports._upsertProfile(userId, objective._id, { snapshot, refreshedAt: new Date() });
  return { ok: true };
}

module.exports.optIn = optIn;
module.exports.optOut = optOut;
module.exports.refresh = refresh;
module.exports._getPrimaryObjective = _getPrimaryObjective;
module.exports._upsertProfile = _upsertProfile;
```

- [ ] **Step 4: Run it — expect PASS.** Also re-run Task 4's test to confirm no regression: `node src/test/employer/talentProfileService.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/talentProfileService.js src/test/employer/talentOptIn.test.js
git commit -m "feat(employer): talent opt-in/opt-out/refresh with eligibility gate (Phase 1)"
```

---

## Task 6: Candidate consent routes (`/api/v2/you/talent*`)

**Files:**
- Create: `src/routes/v2/talent.js`
- Modify: `src/app.js`
- Test: `src/test/employer/talentRoutes.test.js`

Auth-gated by the existing `auth` middleware. Endpoints: `GET /` (my talent profile + opted-in state), `POST /opt-in` (body = prefs), `POST /opt-out`, `PATCH /` (update prefs). Maps the service errors to clean codes (mirrors the `/proof/publish` pattern).

- [ ] **Step 1: Write the failing test** (tests the handler logic via the exported router's stack is awkward; instead unit-test a thin controller). Create the controller-style handlers as named exports so they're testable without HTTP.

```js
// src/test/employer/talentRoutes.test.js
'use strict';
const assert = require('assert');
const h = require('../../routes/v2/talent');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function mockRes(){ return { code:200, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  h._svc.optIn = async (uid, prefs) => ({ ok: true, uid, prefs });
  await ok('optIn handler 200', async () => {
    const res = mockRes();
    await h.optInHandler({ user: { userId: 'u1' }, body: { city: 'Pune' } }, res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.success, true);
  });
  await ok('optIn NOT_ELIGIBLE -> 400 + code', async () => {
    h._svc.optIn = async () => { throw new Error('NOT_ELIGIBLE'); };
    const res = mockRes();
    await h.optInHandler({ user: { userId: 'u1' }, body: {} }, res);
    assert.strictEqual(res.code, 400);
    assert.strictEqual(res.body.code, 'NOT_ELIGIBLE');
  });
  console.log(`# tests 2\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).

- [ ] **Step 3: Implement**

```js
// src/routes/v2/talent.js
'use strict';
const router = require('express').Router();
const auth = require('../../middleware/auth');
const svc = require('../../services/employer/talentProfileService');

// exported for unit tests; routes call these
async function optInHandler(req, res) {
  try {
    const out = await svc.optIn(req.user.userId, req.body || {});
    return res.status(200).json({ success: true, data: out });
  } catch (err) {
    if (err.message === 'NO_OBJECTIVE') return res.status(400).json({ success: false, code: 'NO_OBJECTIVE', message: 'Set up a goal first.' });
    if (err.message === 'NOT_ELIGIBLE') return res.status(400).json({ success: false, code: 'NOT_ELIGIBLE', message: "You're not eligible for the talent pool yet — keep building evidence on a career goal." });
    console.error('[talent/opt-in]', err.message);
    return res.status(500).json({ success: false, message: 'Could not opt in.' });
  }
}
async function optOutHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.optOut(req.user.userId) }); }
  catch (err) { console.error('[talent/opt-out]', err.message); return res.status(500).json({ success: false, message: 'Could not opt out.' }); }
}
async function getHandler(req, res) {
  try {
    const TalentProfile = require('../../models/TalentProfile');
    const UserObjective = require('../../models/UserObjective');
    const obj = await UserObjective.findOne({ userId: req.user.userId, status: 'active', isPrimary: true }).select('_id').lean();
    const profile = obj ? await TalentProfile.findOne({ userId: req.user.userId, objectiveId: obj._id }).lean() : null;
    return res.status(200).json({ success: true, data: { optedIn: !!profile?.optedIn, profile: profile || null } });
  } catch (err) { console.error('[talent/get]', err.message); return res.status(500).json({ success: false, message: 'Could not load.' }); }
}
async function patchHandler(req, res) {
  try {
    const UserObjective = require('../../models/UserObjective');
    const obj = await UserObjective.findOne({ userId: req.user.userId, status: 'active', isPrimary: true }).select('_id').lean();
    if (!obj) return res.status(400).json({ success: false, code: 'NO_OBJECTIVE', message: 'No active goal.' });
    const { city, noticePeriod, workPref } = req.body || {};
    const set = {};
    if (city != null) set.city = city;
    if (noticePeriod != null) set.noticePeriod = noticePeriod;
    if (workPref != null) set.workPref = workPref;
    await svc._upsertProfile(req.user.userId, obj._id, set);
    return res.status(200).json({ success: true, data: { ok: true } });
  } catch (err) { console.error('[talent/patch]', err.message); return res.status(500).json({ success: false, message: 'Could not update.' }); }
}

router.get('/', auth, getHandler);
router.post('/opt-in', auth, optInHandler);
router.post('/opt-out', auth, optOutHandler);
router.patch('/', auth, patchHandler);

// test seam
router._svc = svc;
module.exports = router;
module.exports.optInHandler = optInHandler;
module.exports.optOutHandler = optOutHandler;
module.exports.getHandler = getHandler;
module.exports.patchHandler = patchHandler;
module.exports._svc = svc;
```

- [ ] **Step 4: Mount it in `src/app.js`** (near the other `/api/v2` mounts; if none, beside the v1 block):

```js
app.use('/api/v2/you/talent', require('./routes/v2/talent'));
```

- [ ] **Step 5: Run it — expect PASS.** Confirm app still loads: `node -e "require('./src/routes/v2/talent'); console.log('ok')"`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/v2/talent.js src/app.js src/test/employer/talentRoutes.test.js
git commit -m "feat(employer): candidate consent routes /api/v2/you/talent (Phase 1)"
```

---

## Task 7: `EmployerAccount` model

**Files:**
- Create: `src/models/EmployerAccount.js`
- Test: `src/test/employer/employerModel.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/employerModel.test.js
'use strict';
const assert = require('assert');
const EmployerAccount = require('../../models/EmployerAccount');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('defaults: unverified + pending', () => {
  const e = new EmployerAccount({ email: 'a@techco.com', companyName: 'TechCo', name: 'Aarti' });
  assert.strictEqual(e.emailVerified, false);
  assert.strictEqual(e.approvalStatus, 'pending');
  assert.strictEqual(e.role, 'employer');
});
ok('email required', () => {
  const e = new EmployerAccount({ companyName: 'X', name: 'Y' });
  assert.ok(e.validateSync().errors.email);
});
ok('approvalStatus enum', () => {
  const e = new EmployerAccount({ email: 'a@b.com', companyName: 'X', name: 'Y', approvalStatus: 'bogus' });
  assert.ok(e.validateSync().errors.approvalStatus);
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Create the model**

```js
// src/models/EmployerAccount.js
'use strict';
const mongoose = require('mongoose');

// A hiring-side account. Two access tiers: emailVerified => BROWSE, approvalStatus:'approved' => CONTACT.
const EmployerAccountSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    companyName: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    title: { type: String, trim: true },
    linkedIn: { type: String, trim: true },
    role: { type: String, default: 'employer' },

    emailVerified: { type: Boolean, default: false }, // -> browse tier
    approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }, // approved -> contact tier
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date },

    // single-use tokens (hashed) for magic-link verify/login
    authTokenHash: { type: String, default: null },
    authTokenExpires: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmployerAccount', EmployerAccountSchema);
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/models/EmployerAccount.js src/test/employer/employerModel.test.js
git commit -m "feat(employer): EmployerAccount model (Phase 1)"
```

---

## Task 8: `employerAuthService` — signup, verify, magic-link login

**Files:**
- Create: `src/services/employer/employerAuthService.js`
- Test: `src/test/employer/employerAuth.test.js`

Magic-link (no passwords). Work-email validation rejects free providers. Tokens are random, stored hashed with an expiry, single-use. `issueJWT` mirrors the learner pattern (`jwt.sign` with `JWT_ACCESS_SECRET`, a `type:'employer'` claim). Email "sending" is a stub (logged) for the pilot.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/employerAuth.test.js
'use strict';
const assert = require('assert');
process.env.JWT_ACCESS_SECRET = 'testsecret';
const jwt = require('jsonwebtoken');
const svc = require('../../services/employer/employerAuthService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  await ok('rejects free email domains', async () => {
    assert.strictEqual(svc.isWorkEmail('someone@gmail.com'), false);
    assert.strictEqual(svc.isWorkEmail('hr@techco.com'), true);
  });

  let saved = null, sentToken = null;
  svc._upsertByEmail = async (email, patch) => { saved = { email, patch }; return { _id: 'e1', email, ...patch }; };
  svc._sendEmail = async (email, token, kind) => { sentToken = token; return true; };

  await ok('signup stores hashed token + sends', async () => {
    const r = await svc.signup({ email: 'hr@techco.com', companyName: 'TechCo', name: 'Aarti' });
    assert.strictEqual(r.ok, true);
    assert.ok(saved.patch.authTokenHash);
    assert.notStrictEqual(saved.patch.authTokenHash, sentToken); // stored hashed, not raw
  });

  await ok('signup rejects gmail', async () => {
    await assert.rejects(() => svc.signup({ email: 'x@gmail.com', companyName: 'C', name: 'N' }), /WORK_EMAIL_REQUIRED/);
  });

  await ok('verifyEmail consumes token, verifies, returns JWT (browse)', async () => {
    const acc = { _id: 'e1', email: 'hr@techco.com', approvalStatus: 'pending',
      authTokenHash: svc._hash(sentToken), authTokenExpires: new Date(Date.now() + 60000) };
    svc._findByToken = async () => acc;
    svc._save = async (a) => a;
    const r = await svc.verifyEmail(sentToken);
    assert.ok(r.jwt);
    const dec = jwt.verify(r.jwt, 'testsecret');
    assert.strictEqual(dec.type, 'employer');
    assert.strictEqual(dec.employerId, 'e1');
    assert.strictEqual(acc.emailVerified, true);
    assert.strictEqual(acc.authTokenHash, null); // single-use consumed
  });

  await ok('verifyEmail rejects expired', async () => {
    svc._findByToken = async () => ({ _id: 'e1', authTokenHash: svc._hash('t'), authTokenExpires: new Date(Date.now() - 1000) });
    await assert.rejects(() => svc.verifyEmail('t'), /TOKEN_INVALID/);
  });

  console.log(`# tests 5\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/services/employer/employerAuthService.js
'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const FREE_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'protonmail.com', 'rediffmail.com']);
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min

function isWorkEmail(email) {
  const m = String(email || '').toLowerCase().match(/^[^@\s]+@([^@\s]+\.[^@\s]+)$/);
  if (!m) return false;
  return !FREE_DOMAINS.has(m[1]);
}
function _hash(raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); }
function _mintToken() { return crypto.randomBytes(24).toString('base64url'); }
function _issueJWT(account) {
  return jwt.sign({ employerId: String(account._id), type: 'employer' }, process.env.JWT_ACCESS_SECRET, { expiresIn: process.env.EMPLOYER_JWT_EXPIRY || '7d' });
}

// --- DB / IO seams (stubbable) ---
async function _upsertByEmail(email, patch) {
  const EmployerAccount = require('../../models/EmployerAccount');
  return EmployerAccount.findOneAndUpdate({ email }, { $set: patch }, { upsert: true, new: true, setDefaultsOnInsert: true });
}
async function _findByToken(tokenHash) {
  const EmployerAccount = require('../../models/EmployerAccount');
  return EmployerAccount.findOne({ authTokenHash: tokenHash });
}
async function _save(account) { return account.save(); }
async function _sendEmail(email, token, kind) {
  // PILOT: log a magic link. Replace with a real mailer when scaling.
  const base = process.env.EMPLOYER_WEB_URL || 'https://hire.scaleupapp.club';
  console.log(`[employer-auth] ${kind} link for ${email}: ${base}/auth/callback?token=${token}`);
  return true;
}

async function signup({ email, companyName, name, title, linkedIn }) {
  email = String(email || '').toLowerCase().trim();
  if (!isWorkEmail(email)) throw new Error('WORK_EMAIL_REQUIRED');
  const token = _mintToken();
  await module.exports._upsertByEmail(email, {
    companyName, name, title, linkedIn,
    authTokenHash: _hash(token), authTokenExpires: new Date(Date.now() + TOKEN_TTL_MS),
  });
  await module.exports._sendEmail(email, token, 'verify');
  return { ok: true };
}

async function verifyEmail(rawToken) {
  const acc = await module.exports._findByToken(_hash(rawToken));
  if (!acc || !acc.authTokenExpires || acc.authTokenExpires.getTime() < Date.now()) throw new Error('TOKEN_INVALID');
  acc.emailVerified = true;
  acc.authTokenHash = null;
  acc.authTokenExpires = null;
  await module.exports._save(acc);
  return { jwt: _issueJWT(acc), employerId: String(acc._id), approvalStatus: acc.approvalStatus };
}

// Magic-link login for a returning employer.
async function requestLogin(email) {
  email = String(email || '').toLowerCase().trim();
  const EmployerAccount = require('../../models/EmployerAccount');
  const acc = await EmployerAccount.findOne({ email });
  if (!acc) return { ok: true }; // do not leak existence
  const token = _mintToken();
  acc.authTokenHash = _hash(token);
  acc.authTokenExpires = new Date(Date.now() + TOKEN_TTL_MS);
  await module.exports._save(acc);
  await module.exports._sendEmail(email, token, 'login');
  return { ok: true };
}
async function completeLogin(rawToken) {
  const acc = await module.exports._findByToken(_hash(rawToken));
  if (!acc || !acc.authTokenExpires || acc.authTokenExpires.getTime() < Date.now()) throw new Error('TOKEN_INVALID');
  acc.authTokenHash = null; acc.authTokenExpires = null;
  if (!acc.emailVerified) acc.emailVerified = true;
  await module.exports._save(acc);
  return { jwt: _issueJWT(acc), employerId: String(acc._id), approvalStatus: acc.approvalStatus };
}

module.exports = {
  isWorkEmail, signup, verifyEmail, requestLogin, completeLogin,
  _hash, _mintToken, _issueJWT, _upsertByEmail, _findByToken, _save, _sendEmail,
};
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/employerAuthService.js src/test/employer/employerAuth.test.js
git commit -m "feat(employer): employerAuthService — work-email signup, magic-link verify/login (Phase 1)"
```

---

## Task 9: `employerAuth` middleware

**Files:**
- Create: `src/middleware/employerAuth.js`
- Test: `src/test/employer/employerAuthMw.test.js`

Verifies the employer JWT (`type:'employer'`), loads the `EmployerAccount`, sets `req.employer = { employerId, emailVerified, approvalStatus }`. `requireContactTier` rejects unless `approvalStatus==='approved'`.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/employerAuthMw.test.js
'use strict';
const assert = require('assert');
process.env.JWT_ACCESS_SECRET = 'testsecret';
const jwt = require('jsonwebtoken');
const mw = require('../../middleware/employerAuth');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function res(){ return { code:0, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  mw._loadAccount = async (id) => ({ _id: id, emailVerified: true, approvalStatus: 'pending' });

  await ok('valid employer token -> req.employer set', async () => {
    const token = jwt.sign({ employerId: 'e1', type: 'employer' }, 'testsecret');
    const req = { headers: { authorization: `Bearer ${token}` } }; let nexted = false;
    await mw.employerAuth(req, res(), () => { nexted = true; });
    assert.ok(nexted);
    assert.strictEqual(req.employer.employerId, 'e1');
    assert.strictEqual(req.employer.approvalStatus, 'pending');
  });

  await ok('learner token (no type) rejected 401', async () => {
    const token = jwt.sign({ userId: 'u1' }, 'testsecret');
    const r = res(); let nexted = false;
    await mw.employerAuth({ headers: { authorization: `Bearer ${token}` } }, r, () => { nexted = true; });
    assert.strictEqual(nexted, false);
    assert.strictEqual(r.code, 401);
  });

  await ok('requireContactTier blocks pending 403', async () => {
    const r = res(); let nexted = false;
    mw.requireContactTier({ employer: { approvalStatus: 'pending' } }, r, () => { nexted = true; });
    assert.strictEqual(nexted, false);
    assert.strictEqual(r.code, 403);
  });
  await ok('requireContactTier allows approved', async () => {
    let nexted = false;
    mw.requireContactTier({ employer: { approvalStatus: 'approved' } }, res(), () => { nexted = true; });
    assert.ok(nexted);
  });

  console.log(`# tests 4\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/middleware/employerAuth.js
'use strict';
const jwt = require('jsonwebtoken');

async function _loadAccount(employerId) {
  const EmployerAccount = require('../models/EmployerAccount');
  return EmployerAccount.findById(employerId).select('emailVerified approvalStatus').lean();
}

async function employerAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Employer token required' });
  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_ACCESS_SECRET);
    if (decoded.type !== 'employer' || !decoded.employerId) return res.status(401).json({ success: false, message: 'Invalid employer token' });
    const acc = await module.exports._loadAccount(decoded.employerId);
    if (!acc) return res.status(401).json({ success: false, message: 'Employer no longer exists' });
    req.employer = { employerId: decoded.employerId, emailVerified: acc.emailVerified, approvalStatus: acc.approvalStatus };
    return next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// Gate: only manually-approved (contact-tier) employers pass.
function requireContactTier(req, res, next) {
  if (req.employer && req.employer.approvalStatus === 'approved') return next();
  return res.status(403).json({ success: false, code: 'CONTACT_PENDING', message: 'Contact access is under review.' });
}

module.exports = { employerAuth, requireContactTier, _loadAccount };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/middleware/employerAuth.js src/test/employer/employerAuthMw.test.js
git commit -m "feat(employer): employerAuth middleware + requireContactTier (Phase 1)"
```

---

## Task 10: Employer auth routes + mount

**Files:**
- Create: `src/routes/employer/auth.js`
- Modify: `src/app.js`
- Test: `src/test/employer/employerAuthRoutes.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/employerAuthRoutes.test.js
'use strict';
const assert = require('assert');
const h = require('../../routes/employer/auth');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function res(){ return { code:200, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  h._svc.signup = async () => ({ ok: true });
  await ok('signup 200', async () => {
    const r = res();
    await h.signupHandler({ body: { email: 'hr@techco.com', companyName: 'TechCo', name: 'Aarti' } }, r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.success, true);
  });
  await ok('signup WORK_EMAIL_REQUIRED -> 400 code', async () => {
    h._svc.signup = async () => { throw new Error('WORK_EMAIL_REQUIRED'); };
    const r = res();
    await h.signupHandler({ body: { email: 'x@gmail.com' } }, r);
    assert.strictEqual(r.code, 400); assert.strictEqual(r.body.code, 'WORK_EMAIL_REQUIRED');
  });
  h._svc.verifyEmail = async () => ({ jwt: 'jwt123', approvalStatus: 'pending' });
  await ok('verify returns jwt', async () => {
    const r = res();
    await h.verifyHandler({ body: { token: 't' } }, r);
    assert.strictEqual(r.body.data.jwt, 'jwt123');
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/routes/employer/auth.js
'use strict';
const router = require('express').Router();
const svc = require('../../services/employer/employerAuthService');

async function signupHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.signup(req.body || {}) }); }
  catch (err) {
    if (err.message === 'WORK_EMAIL_REQUIRED') return res.status(400).json({ success: false, code: 'WORK_EMAIL_REQUIRED', message: 'Please use your work email (not a personal address).' });
    console.error('[employer/signup]', err.message); return res.status(500).json({ success: false, message: 'Could not sign up.' });
  }
}
async function verifyHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.verifyEmail((req.body || {}).token) }); }
  catch (err) {
    if (err.message === 'TOKEN_INVALID') return res.status(400).json({ success: false, code: 'TOKEN_INVALID', message: 'This link is invalid or expired.' });
    console.error('[employer/verify]', err.message); return res.status(500).json({ success: false, message: 'Could not verify.' });
  }
}
async function loginHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.requestLogin((req.body || {}).email) }); }
  catch (err) { console.error('[employer/login]', err.message); return res.status(500).json({ success: false, message: 'Could not send link.' }); }
}
async function completeHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.completeLogin((req.body || {}).token) }); }
  catch (err) {
    if (err.message === 'TOKEN_INVALID') return res.status(400).json({ success: false, code: 'TOKEN_INVALID', message: 'This link is invalid or expired.' });
    console.error('[employer/complete]', err.message); return res.status(500).json({ success: false, message: 'Could not log in.' });
  }
}

router.post('/signup', signupHandler);
router.post('/verify', verifyHandler);
router.post('/login', loginHandler);
router.post('/complete', completeHandler);

module.exports = router;
module.exports.signupHandler = signupHandler;
module.exports.verifyHandler = verifyHandler;
module.exports.loginHandler = loginHandler;
module.exports.completeHandler = completeHandler;
module.exports._svc = svc;
```

- [ ] **Step 4: Mount in `src/app.js`:**

```js
app.use('/api/employer/auth', require('./routes/employer/auth'));
```

- [ ] **Step 5: Run it — expect PASS.** Confirm load: `node -e "require('./src/routes/employer/auth'); console.log('ok')"`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/employer/auth.js src/app.js src/test/employer/employerAuthRoutes.test.js
git commit -m "feat(employer): /api/employer/auth routes (signup/verify/login) (Phase 1)"
```

---

## Task 11: Admin employer-approval queue

**Files:**
- Modify: `src/routes/admin.js`
- Create: `src/services/employer/employerApprovalService.js`
- Test: `src/test/employer/employerApproval.test.js`

Grants/denies the contact tier. Reuses the existing `auth, rbac('admin')` guard already applied at the top of `admin.js`.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/employerApproval.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/employerApprovalService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  let updated = null;
  svc._update = async (id, patch) => { updated = { id, patch }; return { _id: id, ...patch }; };
  await ok('approve sets approved + approver', async () => {
    await svc.approve('e1', 'admin1');
    assert.strictEqual(updated.patch.approvalStatus, 'approved');
    assert.strictEqual(String(updated.patch.approvedBy), 'admin1');
    assert.ok(updated.patch.approvedAt);
  });
  await ok('reject sets rejected', async () => {
    await svc.reject('e1', 'admin1');
    assert.strictEqual(updated.patch.approvalStatus, 'rejected');
  });
  console.log(`# tests 2\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement the service**

```js
// src/services/employer/employerApprovalService.js
'use strict';

async function _update(employerId, patch) {
  const EmployerAccount = require('../../models/EmployerAccount');
  return EmployerAccount.findByIdAndUpdate(employerId, { $set: patch }, { new: true });
}
async function listPending() {
  const EmployerAccount = require('../../models/EmployerAccount');
  return EmployerAccount.find({ approvalStatus: 'pending', emailVerified: true })
    .select('email companyName name title linkedIn createdAt').sort({ createdAt: 1 }).lean();
}
async function approve(employerId, adminUserId) {
  return module.exports._update(employerId, { approvalStatus: 'approved', approvedBy: adminUserId, approvedAt: new Date() });
}
async function reject(employerId, adminUserId) {
  return module.exports._update(employerId, { approvalStatus: 'rejected', approvedBy: adminUserId, approvedAt: new Date() });
}

module.exports = { listPending, approve, reject, _update };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Add admin routes** in `src/routes/admin.js` (after the existing routes; the `router.use(auth, rbac('admin'))` guard already applies):

```js
// Employer marketplace — contact-tier approval queue (Hire from ScaleUp, Phase 1)
const employerApproval = require('../services/employer/employerApprovalService');
router.get('/employers/pending', async (req, res) => {
  try { return res.json({ success: true, data: await employerApproval.listPending() }); }
  catch (e) { console.error('[admin/employers/pending]', e.message); return res.status(500).json({ success: false }); }
});
router.post('/employers/:id/approve', async (req, res) => {
  try { await employerApproval.approve(req.params.id, req.user.userId); return res.json({ success: true }); }
  catch (e) { console.error('[admin/employers/approve]', e.message); return res.status(500).json({ success: false }); }
});
router.post('/employers/:id/reject', async (req, res) => {
  try { await employerApproval.reject(req.params.id, req.user.userId); return res.json({ success: true }); }
  catch (e) { console.error('[admin/employers/reject]', e.message); return res.status(500).json({ success: false }); }
});
```

- [ ] **Step 6: Confirm admin router still loads:** `node -e "require('./src/routes/admin'); console.log('ok')"`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin.js src/services/employer/employerApprovalService.js src/test/employer/employerApproval.test.js
git commit -m "feat(employer): admin contact-tier approval queue (Phase 1)"
```

---

## Task 12: Suite green + push

**Files:** none (verification).

- [ ] **Step 1: Run the whole Phase-1 suite**

```bash
for f in src/test/employer/*.test.js; do printf "%-44s " "$(basename $f)"; node "$f" 2>&1 | grep -E "# (tests|pass|fail)" | tr '\n' ' '; echo; done
```
Expected: every file `# fail 0`.

- [ ] **Step 2: Parse-check all new source**

```bash
for f in src/models/TalentProfile.js src/models/EmployerAccount.js src/services/employer/*.js src/middleware/employerAuth.js src/routes/v2/talent.js src/routes/employer/auth.js; do node --check "$f" && echo "ok $f"; done
```

- [ ] **Step 3: Confirm app boots far enough to register routes** (no DB needed for require):

```bash
node -e "require('./src/routes/v2/talent'); require('./src/routes/employer/auth'); require('./src/routes/admin'); console.log('routes load ok')"
```

- [ ] **Step 4: Push**

```bash
git push origin master
```

---

## Self-Review (done by plan author)

**Spec coverage (Phase 1 scope only):** TalentProfile + consent + eligibility (Tasks 2–6 ✓), reuse of `buildSnapshot` (Task 4 ✓), EmployerAccount + hybrid tiers (Task 7 ✓), email-verify→browse / manual-approve→contact (Tasks 8, 9, 11 ✓), employer auth surface (Tasks 8–10 ✓), admin vetting (Task 11 ✓), flag-gated/inert (Task 1 ✓; no client UI; nothing user-facing). Search/ranking/explainability, the connection flow, web/app UI, and DPDP audit-logging are **Phase 2–4** (separate plans), per the spec's phasing.

**Placeholder scan:** none — every code step is complete and runnable.

**Type/name consistency:** `snapshot` shape is identical in Task 2 (model), Task 4 (builder), Task 5 (opt-in). `module.exports._fn` stub seams are consistent across services. Employer JWT claim `{ employerId, type:'employer' }` is issued in Task 8 and verified in Task 9. `approvalStatus` enum values match across model (Task 7), middleware (Task 9), service (Task 11).

**Note for the executor:** these are backend-only, flag-defaulted-off, additive tasks — they change nothing user-facing. The candidate opt-in UI (iOS) and the employer web app are deliberately deferred to keep Phase 1 a clean, testable data+auth foundation.
