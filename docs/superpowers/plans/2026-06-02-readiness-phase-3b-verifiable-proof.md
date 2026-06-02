# Readiness Phase 3B — Verifiable Proof of Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A ready learner publishes a frozen, shareable, verifiable proof — one link that renders a gold "Verified Readiness" card on social and opens a public ScaleUp verify page.

**Architecture:** A `ReadinessProof` freezes the served readiness (read from the latest `ReadinessSnapshot` — no formula duplication) behind an opt-in, revocable token (mirrors the existing `ShareToken` + `/api/coding/public` pattern). A public IP-rate-limited read endpoint feeds a Next.js verify page + OG image on `scaleup-web`. The app's "Go prove it" publishes + opens the native share sheet.

**Tech Stack:** Node/Express/Mongoose + `node:test` (backend); Next.js 15 App Router + `next/og` on Vercel (web); SwiftUI `ShareLink` (iOS); RN `Share` (Android).

**Design spec:** `docs/superpowers/specs/2026-06-02-readiness-phase-3b-verifiable-proof-design.md`
**Builds on:** shipped 3A (`UserObjective.readyState`, `/you/overview` + `/plan/today` `ready` block, `proveItService`).
**Test convention:** single test file = `node <path>` (NOT `node --test`). Backend cwd: `/Users/nirpekshnandan/My Products/ScaleUpDemo/scaleup-backend`.

---

## File Structure

**Backend (`scaleup-backend`)**
- Create `src/models/ReadinessProof.js` — frozen proof + token (mirrors `coding/models/shareToken.model.js`).
- Create `src/services/readiness/proofService.js` — `buildSnapshot`, `publish`, `revoke`, `getPublic`.
- Create `src/routes/publicProof.js` — public `GET /:token` (no auth, IP-rate-limited).
- Modify `src/routes/v2/you.js` — authed `POST /proof/publish`, `POST /proof/revoke`, `GET /proof`.
- Modify `src/app.js` — mount `/api/public/proof` (before auth-gated routers).
- Tests under `src/test/readiness/`.

**Web (`scaleup-web`, cwd `/Users/nirpekshnandan/My Products/scaleup-web`)**
- Create `src/app/r/[token]/page.tsx` — verify page (Server Component).
- Create `src/app/r/[token]/opengraph-image.tsx` — OG card.
- Create `src/app/r/[token]/not-found.tsx` — "no longer shared".

**iOS (`ScaleUpDemo-f`)**
- Modify `ScaleUp/Features/V2/Home/V2WhatsNextView.swift` — publish + `ShareLink`.
- Modify `project.yml` (build 183) + regenerate.

**Android (`ScaleUpDemo-f-Android`)**
- Modify `src/features/v2/screens/V2WhatsNextSheet.tsx` — publish + `Share.share`.
- Modify `src/features/v2/screens/V2HomeScreen.tsx` — pass publish handler.

---

# PHASE A — Backend

### Task 1: `ReadinessProof` model

**Files:** Create `src/models/ReadinessProof.js`; Test `src/test/readiness/readinessProofModel.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const ReadinessProof = require('../../models/ReadinessProof');

test('ReadinessProof holds a token + frozen snapshot, defaults active', () => {
  const p = new ReadinessProof({
    token: 'abc123', userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId(),
    snapshot: { displayName: 'Aditya', objectiveLabel: 'Backend Engineer', score: 84, target: 80, band: 'Strong',
      competencies: [{ name: 'System Design', score: 88, assessed: true }],
      evidence: { assessments: 112, capstonesGraded: 8, coveragePct: 75, hoursInvested: 38 } },
  });
  assert.equal(p.active, true);
  assert.equal(p.viewCount, 0);
  assert.equal(p.snapshot.score, 84);
  assert.equal(p.snapshot.competencies[0].name, 'System Design');
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/readinessProofModel.test.js`

- [ ] **Step 3: Implement** `src/models/ReadinessProof.js`

```js
'use strict';
const mongoose = require('mongoose');

/**
 * A frozen, shareable proof of readiness. Created at publish time from the
 * served readiness; never recomputed (the whole point — a dated credential).
 * Opt-in + revocable, mirroring coding/models/shareToken.model.js.
 */
const ReadinessProofSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', required: true },
    active: { type: Boolean, default: true, index: true },
    issuedAt: { type: Date, default: Date.now },
    viewCount: { type: Number, default: 0 },
    snapshot: {
      displayName: String,
      avatarURL: String,
      objectiveLabel: String,
      score: Number,
      target: Number,
      band: String, // 'Competitive' | 'Strong' | 'Exceptional'
      competencies: [{ name: String, score: Number, assessed: Boolean }],
      evidence: {
        assessments: Number,
        capstonesGraded: Number,
        coveragePct: Number,
        hoursInvested: Number,
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReadinessProof', ReadinessProofSchema);
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/readinessProofModel.test.js`
- [ ] **Step 5: Commit** — `git add src/models/ReadinessProof.js src/test/readiness/readinessProofModel.test.js && git commit -m "feat(readiness): ReadinessProof model (Phase 3B)"`

---

### Task 2: `proofService.buildSnapshot` (freeze from persisted readiness)

**Files:** Create `src/services/readiness/proofService.js`; Test `src/test/readiness/proofBuildSnapshot.test.js`

`buildSnapshot` reuses persisted state — it reads the latest `ReadinessSnapshot` (served `value` + `shadow.breakdown` + `shadow.coverage`) and the objective/user, so it never re-derives the readiness formula.

- [ ] **Step 1: Write the failing test** (models mocked; verifies the freeze shape + band logic)

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('buildSnapshot freezes served readiness + derives band from targetBands', async () => {
  const UserObjective = require('../../models/UserObjective');
  const ReadinessSnapshot = require('../../models/ReadinessSnapshot');
  const User = require('../../models/User');
  const proofService = require('../../services/readiness/proofService');

  const userId = new mongoose.Types.ObjectId();
  const objId = new mongoose.Types.ObjectId();
  const o = { _id: objId, userId, objectiveType: 'interview_preparation', target: 80,
    analysis: { competencies: [{ name: 'System Design', weight: 8 }] }, createdAt: new Date(Date.now() - 14 * 7 * 864e5) };
  const snap = { value: 84, source: 'composite',
    shadow: { value: 84, coverage: 0.75, breakdown: [
      { competency: 'System Design', score: 88, assessed: true, weight: 8 },
      { competency: 'Databases', score: 72, assessed: true, weight: 5 },
    ] } };

  const origs = {};
  origs.uo = UserObjective.findOne; UserObjective.findOne = () => ({ lean: async () => o });
  origs.rs = ReadinessSnapshot.findOne; ReadinessSnapshot.findOne = () => ({ sort: () => ({ lean: async () => snap }) });
  origs.u = User.findById; User.findById = () => ({ select: () => ({ lean: async () => ({ firstName: 'Aditya', lastName: 'S', profilePicture: null }) }) });
  // evidence counts: stub the count helpers proofService uses
  proofService._countEvidence = async () => ({ assessments: 112, capstonesGraded: 8, hoursInvested: 38 });
  try {
    const s = await proofService.buildSnapshot(String(userId));
    assert.equal(s.score, 84);
    assert.equal(s.target, 80);
    assert.equal(s.band, 'Strong'); // 84 >= strong(80), < exceptional(88)
    assert.equal(s.displayName, 'Aditya S');
    assert.equal(s.competencies[0].name, 'System Design');
    assert.equal(s.evidence.coveragePct, 75);
    assert.equal(s.evidence.assessments, 112);
  } finally {
    UserObjective.findOne = origs.uo; ReadinessSnapshot.findOne = origs.rs; User.findById = origs.u;
  }
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/proofBuildSnapshot.test.js`

- [ ] **Step 3: Implement** `src/services/readiness/proofService.js`

```js
'use strict';
const UserObjective = require('../../models/UserObjective');
const ReadinessSnapshot = require('../../models/ReadinessSnapshot');
const User = require('../../models/User');
const { getEffectiveTarget, targetBands } = require('./targetService');

function bandFor(score, bands) {
  if (score >= bands.exceptional) return 'Exceptional';
  if (score >= bands.strong) return 'Strong';
  if (score >= bands.competitive) return 'Competitive';
  return 'Developing';
}

// Cheap evidence counts. Overridable in tests via proofService._countEvidence.
async function _countEvidence(userId) {
  const QuizAttempt = require('../../models/QuizAttempt');
  const InterviewSession = require('../../models/InterviewSession');
  const CapstoneSession = require('../../coding/models/capstoneSession.model');
  const [quizzes, interviews, capstones] = await Promise.all([
    QuizAttempt.countDocuments({ userId }).catch(() => 0),
    InterviewSession.countDocuments({ userId, status: { $in: ['completed', 'evaluated'] } }).catch(() => 0),
    CapstoneSession.countDocuments({ user_id: userId, status: 'graded' }).catch(() => 0),
  ]);
  return { assessments: quizzes + interviews + capstones, capstonesGraded: capstones, hoursInvested: 0 };
}

async function buildSnapshot(userId) {
  const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
  if (!objective) throw new Error('NO_OBJECTIVE');
  const snap = await ReadinessSnapshot.findOne({ userId, objectiveId: objective._id }).sort({ createdAt: -1 }).lean();
  if (!snap) throw new Error('NO_SNAPSHOT');
  const score = typeof snap.value === 'number' ? snap.value : 0;
  const target = getEffectiveTarget(objective);
  const bands = targetBands(target);
  const composite = snap.shadow || {};
  const breakdown = Array.isArray(composite.breakdown) ? composite.breakdown : [];
  const competencies = breakdown
    .filter((b) => b.assessed)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .map((b) => ({ name: b.competency, score: b.score, assessed: true }));
  const user = await User.findById(userId).select('firstName lastName profilePicture').lean();
  const ev = await module.exports._countEvidence(userId);
  return {
    displayName: [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || 'A ScaleUp learner',
    avatarURL: user?.profilePicture || null,
    objectiveLabel: objective.specifics?.targetRole || objective.objectiveType || 'their goal',
    score, target, band: bandFor(score, bands),
    competencies,
    evidence: {
      assessments: ev.assessments,
      capstonesGraded: ev.capstonesGraded,
      coveragePct: typeof composite.coverage === 'number' ? Math.round(composite.coverage * 100) : null,
      hoursInvested: ev.hoursInvested,
    },
  };
}

module.exports = { buildSnapshot, bandFor, _countEvidence };
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/proofBuildSnapshot.test.js`
- [ ] **Step 5: Commit** — `git add src/services/readiness/proofService.js src/test/readiness/proofBuildSnapshot.test.js && git commit -m "feat(readiness): proofService.buildSnapshot freezes served readiness (Phase 3B)"`

---

### Task 3: `proofService.publish` / `revoke` / `getPublic`

**Files:** Modify `src/services/readiness/proofService.js`; Test `src/test/readiness/proofPublish.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('publish requires Ready, mints a token; revoke deactivates; getPublic reads active', async () => {
  const UserObjective = require('../../models/UserObjective');
  const ReadinessProof = require('../../models/ReadinessProof');
  const proofService = require('../../services/readiness/proofService');
  const userId = new mongoose.Types.ObjectId();
  const objId = new mongoose.Types.ObjectId();

  const origObj = UserObjective.findOne;
  UserObjective.findOne = () => ({ lean: async () => ({ _id: objId, userId, readyState: { isReady: true } }) });
  proofService.buildSnapshot = async () => ({ objectiveLabel: 'Backend Engineer', score: 84 });
  const created = [];
  const origCreate = ReadinessProof.create;
  ReadinessProof.create = async (doc) => { created.push(doc); return { ...doc, _id: new mongoose.Types.ObjectId() }; };
  try {
    const out = await proofService.publish(String(userId));
    assert.ok(out.token && out.url.includes(out.token));
    assert.equal(created[0].snapshot.score, 84);
    assert.equal(created[0].active, true);
  } finally {
    UserObjective.findOne = origObj; ReadinessProof.create = origCreate;
  }
});

test('publish throws NOT_READY when not ready', async () => {
  const UserObjective = require('../../models/UserObjective');
  const proofService = require('../../services/readiness/proofService');
  const orig = UserObjective.findOne;
  UserObjective.findOne = () => ({ lean: async () => ({ _id: new mongoose.Types.ObjectId(), readyState: { isReady: false } }) });
  try {
    await assert.rejects(() => proofService.publish('x'), /NOT_READY/);
  } finally { UserObjective.findOne = orig; }
});
```

- [ ] **Step 2: Run, verify FAIL** — `node src/test/readiness/proofPublish.test.js`

- [ ] **Step 3: Implement** — append to `proofService.js` (and extend `module.exports`)

```js
const crypto = require('crypto');
const ReadinessProof = require('../../models/ReadinessProof');

const WEB_BASE = process.env.PUBLIC_WEB_BASE || 'https://scaleupapp.club';
function mintToken() { return crypto.randomBytes(12).toString('base64url'); } // ~16 chars, infeasible to guess

async function publish(userId) {
  const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
  if (!objective) throw new Error('NO_OBJECTIVE');
  if (!objective.readyState?.isReady) throw new Error('NOT_READY');
  const snapshot = await module.exports.buildSnapshot(userId);
  const token = mintToken();
  await ReadinessProof.create({ token, userId, objectiveId: objective._id, active: true, issuedAt: new Date(), snapshot });
  const shareText = `I'm ${snapshot.objectiveLabel}-ready — verified by ScaleUp.`;
  return { token, url: `${WEB_BASE}/r/${token}`, shareText };
}

async function revoke(userId, token) {
  const q = { userId, active: true };
  if (token) q.token = token;
  await ReadinessProof.updateMany(q, { $set: { active: false } });
  return { ok: true };
}

async function getActive(userId) {
  const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).select('_id').lean();
  if (!objective) return null;
  const p = await ReadinessProof.findOne({ userId, objectiveId: objective._id, active: true }).sort({ createdAt: -1 }).lean();
  return p ? { token: p.token, url: `${WEB_BASE}/r/${p.token}`, issuedAt: p.issuedAt } : null;
}

async function getPublic(token) {
  const p = await ReadinessProof.findOne({ token, active: true }).lean();
  if (!p) return null;
  ReadinessProof.updateOne({ _id: p._id }, { $inc: { viewCount: 1 } }).catch(() => {});
  return { issuedAt: p.issuedAt, ...p.snapshot };
}

module.exports.publish = publish;
module.exports.revoke = revoke;
module.exports.getActive = getActive;
module.exports.getPublic = getPublic;
module.exports.mintToken = mintToken;
```

- [ ] **Step 4: Run, verify PASS** — `node src/test/readiness/proofPublish.test.js`
- [ ] **Step 5: Commit** — `git add src/services/readiness/proofService.js src/test/readiness/proofPublish.test.js && git commit -m "feat(readiness): proof publish/revoke/getPublic (Phase 3B)"`

---

### Task 4: Authed proof routes

**Files:** Modify `src/routes/v2/you.js`

- [ ] **Step 1: Add three routes** (near the `/ready/seen` route from 3A):

```js
router.post('/proof/publish', auth, async (req, res) => {
  try {
    const out = await require('../../services/readiness/proofService').publish(req.user.userId);
    require('../../services/diagnosticTelemetryService').logEvent('proof.published', { userId: String(req.user.userId) });
    res.json({ success: true, data: out });
  } catch (err) {
    if (err.message === 'NOT_READY') return res.status(400).json({ success: false, message: 'Not ready yet.', code: 'NOT_READY' });
    console.error('[v2/you/proof/publish]', err.message);
    res.status(500).json({ success: false, message: 'Could not publish proof.' });
  }
});
router.post('/proof/revoke', auth, async (req, res) => {
  try {
    await require('../../services/readiness/proofService').revoke(req.user.userId, req.body?.token);
    res.json({ success: true, data: { ok: true } });
  } catch (err) { res.status(500).json({ success: false, message: 'Could not revoke.' }); }
});
router.get('/proof', auth, async (req, res) => {
  try {
    const out = await require('../../services/readiness/proofService').getActive(req.user.userId);
    res.json({ success: true, data: out });
  } catch (err) { res.status(500).json({ success: false, message: 'Could not load proof.' }); }
});
```

- [ ] **Step 2: Verify parse** — `node --check src/routes/v2/you.js`
- [ ] **Step 3: Commit** — `git add src/routes/v2/you.js && git commit -m "feat(readiness): authed proof publish/revoke/get routes (Phase 3B)"`

---

### Task 5: Public proof route + mount

**Files:** Create `src/routes/publicProof.js`; Modify `src/app.js`

- [ ] **Step 1: Create `src/routes/publicProof.js`**

```js
'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const proofService = require('../services/readiness/proofService');

// Public, unauthenticated. IP-keyed, recruiter-friendly (120/min). Guessing a
// 16-char base64url token is infeasible.
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'anon' });

router.get('/:token', limiter, async (req, res) => {
  try {
    const proof = await proofService.getPublic(req.params.token);
    if (!proof) return res.status(404).json({ success: false, message: 'This proof is no longer shared.' });
    res.json({ success: true, data: proof });
  } catch (err) {
    console.error('[publicProof]', err.message);
    res.status(500).json({ success: false, message: 'Could not load this proof.' });
  }
});

module.exports = router;
```

(If `express-rate-limit` is not a dependency, reuse the project's existing limiter — check `coding/middleware/codingRateLimit.js` and import the same `rl` middleware with `{ endpoint:'public-proof', max:120, keyFn: (req)=>req.ip }`. Pin in implementation.)

- [ ] **Step 2: Mount in `src/app.js`** — next to the other `/api/public`-style mount (search for `/api/coding/public`), add BEFORE any auth middleware:

```js
app.use('/api/public/proof', require('./routes/publicProof'));
```

- [ ] **Step 3: Verify parse** — `node --check src/routes/publicProof.js && node --check src/app.js`
- [ ] **Step 4: Commit** — `git add src/routes/publicProof.js src/app.js && git commit -m "feat(readiness): public GET /api/public/proof/:token (Phase 3B)"`

---

### Task 6: Run suite + push

- [ ] **Step 1:** `for f in src/test/readiness/proof*.test.js src/test/readiness/readinessProofModel.test.js; do echo "## $f"; node "$f" 2>&1 | grep -E "# (tests|pass|fail)"; done` — all `# fail 0`.
- [ ] **Step 2:** `node --check src/routes/v2/you.js && node --check src/routes/publicProof.js && node --check src/app.js && echo OK`
- [ ] **Step 3:** `git push origin master`

---

# PHASE B — Web (`scaleup-web`)

cwd: `/Users/nirpekshnandan/My Products/scaleup-web`. First, find the API base the existing public pages use: `grep -rnE "API|fetch\(|process.env" src/app/capstone src/app/profile src/lib | head`. Use the SAME base (call it `API_BASE` below — it resolves to the backend origin, e.g. `https://api.scaleupapp.club`).

### Task 7: Verify page `app/r/[token]/page.tsx`

- [ ] **Step 1: Create `src/app/r/[token]/page.tsx`** (Server Component; renders the approved design)

```tsx
import { notFound } from 'next/navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'https://api.scaleupapp.club'

async function getProof(token: string) {
  const res = await fetch(`${API_BASE}/api/public/proof/${token}`, { next: { revalidate: 300 } })
  if (!res.ok) return null
  const json = await res.json()
  return json?.data ?? null
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const p = await getProof(token)
  if (!p) return { title: 'Proof not found · ScaleUp' }
  return {
    title: `${p.displayName} · ${p.objectiveLabel}-ready · ScaleUp`,
    description: `Verified ${p.score}% ready for ${p.objectiveLabel} — ${p.evidence?.assessments ?? 0} assessments.`,
  }
}

export default async function ProofPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const p = await getProof(token)
  if (!p) notFound()
  const comps = (p.competencies ?? []) as Array<{ name: string; score: number }>
  const color = (s: number) => (s >= 70 ? '#34D399' : s >= 40 ? '#FBBF24' : '#EF4444')
  return (
    <main style={{ minHeight: '100vh', background: '#0B1E28', color: '#fff', display: 'flex', justifyContent: 'center', padding: 20, fontFamily: 'system-ui' }}>
      <div style={{ maxWidth: 460, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 16, borderBottom: '1px solid #1A3B4D' }}>
          <div style={{ width: 48, height: 48, borderRadius: 24, background: '#1A3B4D', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, overflow: 'hidden' }}>
            {p.avatarURL ? <img src={p.avatarURL} alt="" width={48} height={48} /> : (p.displayName?.[0] ?? 'S')}
          </div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{p.displayName}</div>
            <div style={{ fontSize: 12, color: '#A3C4D4' }}>verified for <b style={{ color: '#fff' }}>{p.objectiveLabel}</b></div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#34D399', fontWeight: 700 }}>✓ VERIFIED</div>
            <div style={{ fontSize: 10, color: '#6B94A6' }}>{new Date(p.issuedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</div>
          </div>
        </div>
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: 52, fontWeight: 800, color: '#E8B84B', lineHeight: 1 }}>{p.score}%</div>
          <div style={{ fontSize: 13, color: '#A3C4D4' }}>Ready · cleared the <b style={{ color: '#fff' }}>{p.band}</b> band (target {p.target}%)</div>
        </div>
        <div style={{ fontSize: 10, letterSpacing: 1, color: '#E8B84B', fontWeight: 700, marginBottom: 8 }}>MEASURED COMPETENCIES</div>
        {comps.map((c) => (
          <div key={c.name} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between' }}><span>{c.name}</span><span style={{ color: color(c.score) }}>{c.score}%</span></div>
            <div style={{ height: 5, background: '#1A3B4D', borderRadius: 3, marginTop: 3 }}><div style={{ width: `${Math.min(100, c.score)}%`, height: 5, background: color(c.score), borderRadius: 3 }} /></div>
          </div>
        ))}
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #1A3B4D', display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#A3C4D4', textAlign: 'center' }}>
          <div><b style={{ color: '#fff' }}>{p.evidence?.assessments ?? 0}</b><br />assessments</div>
          <div><b style={{ color: '#fff' }}>{p.evidence?.capstonesGraded ?? 0}</b><br />capstones</div>
          <div><b style={{ color: '#fff' }}>{p.evidence?.coveragePct ?? 0}%</b><br />of role measured</div>
        </div>
        <div style={{ marginTop: 16, fontSize: 10, color: '#6B94A6', textAlign: 'center' }}>Point-in-time snapshot · Verified by ScaleUp · measured across quizzes, coding & interviews</div>
      </div>
    </main>
  )
}
```

- [ ] **Step 2: Create `src/app/r/[token]/not-found.tsx`**

```tsx
export default function NotFound() {
  return (
    <main style={{ minHeight: '100vh', background: '#0B1E28', color: '#A3C4D4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 28 }}>🔒</div>
        <p>This proof is no longer shared.</p>
      </div>
    </main>
  )
}
```

- [ ] **Step 3: Typecheck/build** — `npm run build 2>&1 | tail -20` (expect the new route compiles; ignore unrelated warnings).
- [ ] **Step 4: Commit** — `git add src/app/r && git commit -m "feat(web): readiness proof verify page /r/[token] (Phase 3B)"`

---

### Task 8: OG image `app/r/[token]/opengraph-image.tsx`

- [ ] **Step 1: Create `src/app/r/[token]/opengraph-image.tsx`**

```tsx
import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'https://api.scaleupapp.club'

export default async function Image({ params }: { params: { token: string } }) {
  let p: any = null
  try {
    const res = await fetch(`${API_BASE}/api/public/proof/${params.token}`)
    if (res.ok) p = (await res.json())?.data
  } catch {}
  const name = p?.displayName ?? 'A ScaleUp learner'
  const objective = p?.objectiveLabel ?? 'their goal'
  const score = p?.score ?? ''
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', gap: 48, padding: 64,
        background: 'radial-gradient(120% 90% at 80% 10%, #16384A, #0B1E28)', color: '#fff', fontFamily: 'sans-serif' }}>
        <div style={{ width: 200, height: 200, borderRadius: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(135deg,#F5D980,#C99A2E)' }}>
          <div style={{ width: 168, height: 168, borderRadius: 84, background: '#0B1E28', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: 34, color: '#E8B84B' }}>★</div>
            <div style={{ fontSize: 56, fontWeight: 800 }}>{score}%</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 22, letterSpacing: 2, color: '#E8B84B', fontWeight: 700 }}>SCALEUP · VERIFIED READINESS</div>
          <div style={{ fontSize: 52, fontWeight: 800, marginTop: 8 }}>{name} is {objective}-ready</div>
          <div style={{ fontSize: 26, color: '#A3C4D4', marginTop: 8 }}>Verified by ScaleUp · scaleupapp.club</div>
        </div>
      </div>
    ),
    { ...size }
  )
}
```

- [ ] **Step 2: Build** — `npm run build 2>&1 | tail -20` (the og route should compile).
- [ ] **Step 3: Commit** — `git add src/app/r/[token]/opengraph-image.tsx && git commit -m "feat(web): OG share card for proof page (Phase 3B)"`

---

### Task 9: Deploy web + verify

- [ ] **Step 1: Push** — `git push origin main` (Vercel auto-deploys; if the repo isn't auto-deploying per prior notes, run `vercel build --prod && vercel deploy --prebuilt --prod`).
- [ ] **Step 2: Smoke** — after a backend test token exists, `curl -s https://api.scaleupapp.club/api/public/proof/<token> | head` returns JSON; the page at `https://scaleupapp.club/r/<token>` renders. (If no token yet, defer to end-to-end after the app can publish.)

---

# PHASE C — iOS (`ScaleUpDemo-f`)

### Task 10: "Go prove it" → publish + ShareLink

**Files:** Modify `ScaleUp/Features/V2/Home/V2WhatsNextView.swift` (the prove-it row from 3A)

- [ ] **Step 1: Add a publish call + share state.** In `V2WhatsNextView`, replace the prove-it row's action so it (a) POSTs `/you/proof/publish`, (b) on success presents a share sheet with the returned URL. Add:

```swift
    @State private var shareURL: URL?
    @State private var publishing = false

    private func publishAndShare() {
        publishing = true
        Task {
            struct Empty: Codable {}
            struct PubResp: Codable { let url: String }
            do {
                let r: V2APIResponse<PubResp> = try await V2APIClient.shared.post("/you/proof/publish", body: Empty())
                if let u = URL(string: r.data.url) { shareURL = u }
            } catch { /* toast handled by caller */ }
            publishing = false
        }
    }
```

Wire the prove-it card's tap to `publishAndShare()` when `ready.proveIt?.comingSoonProof == true` (it now means "publish + share"), and attach a share sheet:

```swift
    .sheet(item: $shareURL) { url in
        ActivityView(items: [url])  // see Step 2
    }
```

Make `URL` identifiable for `.sheet(item:)` by adding (file-scope): `extension URL: Identifiable { public var id: String { absoluteString } }`.

- [ ] **Step 2: Add a UIActivityViewController wrapper** (SwiftUI `ShareLink` also works on iOS 16+, but a wrapper avoids gating). Add at file scope:

```swift
import UIKit
struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
```

(If `V2APIResponse`/`V2APIClient.shared.post` signatures differ, match the ones used elsewhere in this file/Home — grep `V2APIClient.shared.post`.)

- [ ] **Step 3: Commit** — `git add ScaleUp/Features/V2/Home/V2WhatsNextView.swift && git commit -m "feat(readiness/ios): Go-prove-it publishes proof + share sheet (Phase 3B)"`

---

### Task 11: iOS build 183 → TestFlight

- [ ] **Step 1:** bump `project.yml` `CURRENT_PROJECT_VERSION` to `183`; `/opt/homebrew/Cellar/xcodegen/2.45.3/bin/xcodegen generate`; commit `project.yml` + `ScaleUp.xcodeproj/project.pbxproj`.
- [ ] **Step 2: Archive** (API-key signing; clean to avoid stale DerivedData):

```bash
rm -rf ~/Library/Developer/Xcode/DerivedData/ScaleUp-* build/ScaleUp.xcarchive
xcodebuild -project ScaleUp.xcodeproj -scheme ScaleUp -configuration Release -archivePath build/ScaleUp.xcarchive \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  -authenticationKeyPath /Users/nirpekshnandan/.private_keys/AuthKey_A4MNMMCCVB.p8 \
  -authenticationKeyID A4MNMMCCVB -authenticationKeyIssuerID 0bbf6f7f-a7cf-4b88-8759-4c85e5c0f240 clean archive
```
Expected `** ARCHIVE SUCCEEDED **`.

- [ ] **Step 3: Export + upload**

```bash
xcodebuild -exportArchive -archivePath build/ScaleUp.xcarchive -exportPath build/ipa -exportOptionsPlist ExportOptions.plist \
  -allowProvisioningUpdates -authenticationKeyPath /Users/nirpekshnandan/.private_keys/AuthKey_A4MNMMCCVB.p8 \
  -authenticationKeyID A4MNMMCCVB -authenticationKeyIssuerID 0bbf6f7f-a7cf-4b88-8759-4c85e5c0f240
```
Expected `Upload succeeded`.

- [ ] **Step 4:** `git push origin master`

---

# PHASE D — Android (`ScaleUpDemo-f-Android`)

### Task 12: "Go prove it" → publish + Share.share

**Files:** Modify `src/features/v2/screens/V2WhatsNextSheet.tsx` + `src/features/v2/screens/V2HomeScreen.tsx`

- [ ] **Step 1: V2HomeScreen** — add a publish+share handler and pass it to the sheet:

```tsx
import { Share } from 'react-native'
// ...
const publishProof = async () => {
  try {
    const res = await V2Api.post<{ url: string; shareText: string }>('/you/proof/publish', {})
    const url = res.data?.url
    if (url) await Share.share({ message: `${res.data?.shareText ?? ''} ${url}`.trim() })
  } catch {}
}
```

Pass `onProve` to call `publishProof()` for the proof route (replace the prior interim routing for the proof teaser):

```tsx
onProve={(route) => { setShowWhatsNext(false); if (route === 'interview') navigation.navigate('InterviewHistory'); else void publishProof() }}
```

- [ ] **Step 2: V2WhatsNextSheet** — the prove-it row already calls `onProve(proveIt.route)`; update the subtitle copy when `comingSoonProof` to "Share your verified proof." (no longer "coming soon"). Minimal copy change.

- [ ] **Step 3: Typecheck** — `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "V2HomeScreen|V2WhatsNextSheet" || echo clean`
- [ ] **Step 4: Commit + push** — `git add src/features/v2/screens/V2HomeScreen.tsx src/features/v2/screens/V2WhatsNextSheet.tsx && git commit -m "feat(readiness/android): Go-prove-it publishes proof + native share (Phase 3B)" && git push origin main`

---

## Self-Review (by plan author)

**Spec coverage:** ReadinessProof model → T1; buildSnapshot (freeze from persisted snapshot) → T2; publish/revoke/getActive/getPublic → T3; authed routes → T4; public route + mount → T5; verify page → T7; OG card → T8; deploy → T9; iOS publish+share → T10–11; Android publish+share → T12; frozen+reissue (new token each publish, old stay active unless revoked) → T3 logic; opt-in/revocable → T3/T4; privacy (presentation-only payload) → T1 snapshot shape; rate-limited public read → T5; edge cases (NOT_READY, revoked→404/not-found) → T3/T4/T5/T7. All mapped.

**Flagged planning decisions (explicit, not placeholders):** (a) rate-limiter dependency — use `express-rate-limit` if present, else the existing `codingRateLimit` `rl`; pin after checking. (b) Web API base env — match the existing `capstone`/`profile` public pages' fetch. (c) iOS `V2APIResponse`/`post` signatures + `V2APIClient` — match the file's existing usage (grep). (d) `hoursInvested` is left 0 in `_countEvidence` for v1 (the evidence strip still shows assessments/capstones/coverage); wire real hours later if desired. (e) Android nav route `InterviewHistory` reused from 3A.

**Out of scope (per spec):** downloadable PNG, recruiter accounts, per-viewer analytics, Phase 4.
