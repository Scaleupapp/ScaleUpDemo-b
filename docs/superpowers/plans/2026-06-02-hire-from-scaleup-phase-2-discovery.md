# Hire from ScaleUp — Phase 2 (Discovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a verified employer search the talent pool and get an **evidence-ranked, anonymized** candidate list + an anonymized candidate profile with an explainable "why this rank" — all backend, flag-gated, no PII before the Phase-3 connection.

**Architecture:** Three pure-ish services over the Phase-1 `TalentProfile` — `talentRankingService` (deterministic lexicographic match score + `explain`), `talentAnonymizer` (PII-stripped browse card + fuller anonymized profile), `employerSearchService` (filter → query → rank → anonymize) — plus two `employerAuth`-gated routes. Reads the `snapshot` the Phase-1 opt-in already denormalized; no new readiness logic.

**Tech Stack:** Node/Express, Mongoose, existing `employerAuth` middleware + `FEATURE_EMPLOYER_MARKETPLACE` flag. Tests run with `node <path>` (NOT node --test), no DB, stubbing via the `module.exports._fn` seam.

**Phase-1 context the code depends on (do NOT change):**
- `TalentProfile.snapshot` = `{ roleLabel, objectiveType, targetCompany, readinessBand ('Competitive'|'Strong'|'Exceptional'|'Developing'), readinessScore, target, competencies:[{name,score}], evidence:{assessments,capstonesGraded,interviews,coveragePct}, codingMastery, achieved, verified, proofToken, lastActiveAt }`. Top-level: `optedIn, status('active'|'paused'), city, noticePeriod, workPref`.
- `src/middleware/employerAuth.js` exports `employerAuth` (sets `req.employer = { employerId, emailVerified, approvalStatus }`; a valid token implies emailVerified ⇒ browse tier) and `requireContactTier`.
- `src/routes/v2/talent.js` exports a `flagGuard` (404 when `!featureFlags.employerMarketplace`) — mirror its pattern.
- `src/routes/employer/auth.js` is mounted at `/api/employer/auth` in `app.js`.

---

## File Structure

**Create:**
- `src/services/employer/talentRankingService.js` — `BAND_RANK`, `scoreOne`, `rank`, `explain`.
- `src/services/employer/talentAnonymizer.js` — `anonHandle`, `toBrowseCard`, `toAnonymizedProfile`.
- `src/services/employer/employerSearchService.js` — `buildQuery`, `search`.
- `src/routes/employer/search.js` — `GET /search`, `GET /candidates/:id` (+ `flagGuard`, `employerAuth`).
- Tests under `src/test/employer/`.

**Modify:**
- `src/app.js` — mount `app.use('/api/employer', require('./routes/employer/search'))` (after the existing `/api/employer/auth` mount).

---

## Task 1: `talentRankingService` — deterministic match score

**Files:**
- Create: `src/services/employer/talentRankingService.js`
- Test: `src/test/employer/ranking.test.js`

The spec's priority is lexicographic: **Achieved → Verified → Band → readinessScore → Evidence depth → Recency**. Encode it as one number with separated magnitudes so higher-priority signals always dominate.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/ranking.test.js
'use strict';
const assert = require('assert');
const { scoreOne, rank, BAND_RANK } = require('../../services/employer/talentRankingService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

const base = { snapshot: { readinessBand: 'Strong', readinessScore: 80, achieved: false, verified: false,
  evidence: { assessments: 5, capstonesGraded: 0, interviews: 0, coveragePct: 60 }, lastActiveAt: new Date('2020-01-01') } };
function withSnap(p){ return { snapshot: { ...base.snapshot, ...p } }; }

ok('achieved dominates everything', () => {
  const achievedWeak = withSnap({ achieved: true, readinessBand: 'Competitive', readinessScore: 55 });
  const notAchievedStrong = withSnap({ achieved: false, verified: true, readinessBand: 'Exceptional', readinessScore: 95 });
  assert.ok(scoreOne(achievedWeak) > scoreOne(notAchievedStrong));
});
ok('verified beats unverified when achieved equal', () => {
  assert.ok(scoreOne(withSnap({ verified: true })) > scoreOne(withSnap({ verified: false })));
});
ok('higher band beats lower when achieved+verified equal', () => {
  assert.ok(scoreOne(withSnap({ readinessBand: 'Exceptional' })) > scoreOne(withSnap({ readinessBand: 'Strong' })));
});
ok('within same band, higher score wins', () => {
  assert.ok(scoreOne(withSnap({ readinessScore: 88 })) > scoreOne(withSnap({ readinessScore: 82 })));
});
ok('band ordering map', () => {
  assert.ok(BAND_RANK.Exceptional > BAND_RANK.Strong && BAND_RANK.Strong > BAND_RANK.Competitive && BAND_RANK.Competitive > BAND_RANK.Developing);
});
ok('rank sorts descending + is deterministic', () => {
  const a = withSnap({ achieved: true }); const b = withSnap({ verified: true }); const c = withSnap({});
  const out = rank([c, a, b]);
  assert.deepStrictEqual(out.map((x) => x === a ? 'a' : x === b ? 'b' : 'c'), ['a', 'b', 'c']);
});
console.log(`# tests 6\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).

- [ ] **Step 3: Implement**

```js
// src/services/employer/talentRankingService.js
'use strict';

// Higher = better. Developing is the floor (shouldn't appear in-pool but handled).
const BAND_RANK = { Exceptional: 3, Strong: 2, Competitive: 1, Developing: 0 };

const DAY = 24 * 60 * 60 * 1000;
function _recencyPoints(lastActiveAt) {
  if (!lastActiveAt) return 0;
  const ageDays = (Date.now() - new Date(lastActiveAt).getTime()) / DAY;
  if (ageDays <= 7) return 30;
  if (ageDays <= 30) return 15;
  if (ageDays <= 90) return 5;
  return 0;
}
function _evidenceDepth(s) {
  const e = s.evidence || {};
  const count = Math.min(40, (e.assessments || 0) + (e.capstonesGraded || 0) + (e.interviews || 0));
  const cov = typeof e.coveragePct === 'number' ? e.coveragePct : 0;
  return Math.round(cov * 0.6 + count); // 0..~100
}

// One lexicographic number: achieved > verified > band > readinessScore > evidence > recency.
// Magnitudes are separated so a higher-priority signal can never be outweighed by lower ones.
function scoreOne(profile) {
  const s = (profile && profile.snapshot) || {};
  const achieved = s.achieved ? 1 : 0;
  const verified = s.verified ? 1 : 0;
  const band = BAND_RANK[s.readinessBand] || 0;            // 0..3
  const score = Math.max(0, Math.min(100, s.readinessScore || 0)); // 0..100
  const evidence = _evidenceDepth(s);                      // 0..~100
  const recency = _recencyPoints(s.lastActiveAt);          // 0..30
  return achieved * 1e12 + verified * 1e10 + band * 1e8 + score * 1e5 + evidence * 1e2 + recency;
}

// Stable descending sort. Tie-break on a stable id so order is deterministic across calls.
function rank(profiles) {
  return [...(profiles || [])].sort((a, b) => {
    const d = scoreOne(b) - scoreOne(a);
    if (d !== 0) return d;
    return String(a && a._id || '').localeCompare(String(b && b._id || ''));
  });
}

module.exports = { BAND_RANK, scoreOne, rank };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/talentRankingService.js src/test/employer/ranking.test.js
git commit -m "feat(employer): deterministic talent ranking score (Phase 2)"
```

---

## Task 2: `talentRankingService.explain` — the "why this rank" signals

**Files:**
- Modify: `src/services/employer/talentRankingService.js`
- Test: `src/test/employer/explain.test.js`

Returns an ordered array of `{ key, label, detail, kind }` — only the signals that are actually present, each evidence-backed. Powers the UI panel.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/explain.test.js
'use strict';
const assert = require('assert');
const { explain } = require('../../services/employer/talentRankingService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('achiever + verified + exceptional yields those signals in priority order', () => {
  const sigs = explain({ snapshot: { achieved: true, verified: true, readinessBand: 'Exceptional', readinessScore: 88, target: 80,
    evidence: { assessments: 14, capstonesGraded: 3, interviews: 2, coveragePct: 92 }, lastActiveAt: new Date() } });
  const keys = sigs.map((s) => s.key);
  assert.deepStrictEqual(keys.slice(0, 3), ['achieved', 'verified', 'band']);
  assert.ok(sigs.find((s) => s.key === 'band').detail.includes('88'));
});
ok('omits signals not present (no achieved/verified)', () => {
  const sigs = explain({ snapshot: { achieved: false, verified: false, readinessBand: 'Strong', readinessScore: 81, target: 80,
    evidence: { assessments: 3, capstonesGraded: 0, interviews: 0, coveragePct: 50 }, lastActiveAt: new Date('2019-01-01') } });
  assert.ok(!sigs.find((s) => s.key === 'achieved'));
  assert.ok(!sigs.find((s) => s.key === 'verified'));
  assert.ok(!sigs.find((s) => s.key === 'recency')); // stale
});
ok('every signal has label + detail + kind', () => {
  const sigs = explain({ snapshot: { achieved: true, verified: true, readinessBand: 'Strong', readinessScore: 80, target: 80,
    evidence: { assessments: 5, capstonesGraded: 1, interviews: 0, coveragePct: 70 }, lastActiveAt: new Date() } });
  sigs.forEach((s) => { assert.ok(s.label && s.detail && s.kind); });
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL** (`explain` undefined).

- [ ] **Step 3: Implement (append to `talentRankingService.js`)**

```js
// Evidence-backed "why this rank" — only signals that are actually present, in priority order.
function explain(profile) {
  const s = (profile && profile.snapshot) || {};
  const e = s.evidence || {};
  const out = [];
  if (s.achieved) out.push({ key: 'achieved', kind: 'good', label: 'Achieved their goal', detail: 'Reported a confirmed outcome after reaching readiness — the strongest signal there is.' });
  if (s.verified) out.push({ key: 'verified', kind: 'good', label: 'Independently verifiable', detail: 'Published a point-in-time proof badge anyone can check.' });
  if (s.readinessBand && s.readinessBand !== 'Developing') {
    const vs = typeof s.target === 'number' ? ` (${s.readinessScore} vs ${s.target} target)` : '';
    out.push({ key: 'band', kind: 'band', label: `${s.readinessBand} band${vs}`, detail: `Cleared the ${s.readinessBand} bar this role requires.` });
  }
  const count = (e.assessments || 0) + (e.capstonesGraded || 0) + (e.interviews || 0);
  if (count > 0) {
    const cov = typeof e.coveragePct === 'number' ? `, ${e.coveragePct}% of the role measured` : '';
    out.push({ key: 'evidence', kind: 'evidence', label: 'Backed by real evidence', detail: `${count} assessment${count === 1 ? '' : 's'}${cov}.` });
  }
  if (_recencyPoints(s.lastActiveAt) >= 15) out.push({ key: 'recency', kind: 'recency', label: 'Recently active', detail: 'A fresh signal — readiness reflects current ability, not a stale snapshot.' });
  return out;
}

module.exports.explain = explain;
```

- [ ] **Step 4: Run it — expect PASS.** Re-run Task 1's test (no regression).

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/talentRankingService.js src/test/employer/explain.test.js
git commit -m "feat(employer): explainable ranking signals (Phase 2)"
```

---

## Task 3: `talentAnonymizer` — PII-stripped projections

**Files:**
- Create: `src/services/employer/talentAnonymizer.js`
- Test: `src/test/employer/anonymizer.test.js`

`anonHandle(id)` → a stable pseudonymous "Candidate #NNNN". `toBrowseCard` = the search-row shape (no PII). `toAnonymizedProfile` = the fuller profile (competencies, evidence, why) — still no name/contact. **Never** emit `userId`, name, email, phone, or `proofToken` raw in a way that deanonymizes (the proof badge link is Phase 3, post-approval).

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/anonymizer.test.js
'use strict';
const assert = require('assert');
const { anonHandle, toBrowseCard, toAnonymizedProfile } = require('../../services/employer/talentAnonymizer');
const ranking = require('../../services/employer/talentRankingService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

const profile = {
  _id: '0123456789abcdef01234567', userId: 'USERSECRET', city: 'Bangalore', noticePeriod: '30 days', workPref: 'hybrid',
  snapshot: { roleLabel: 'Backend Engineer', objectiveType: 'interview_preparation', readinessBand: 'Exceptional', readinessScore: 88, target: 80,
    competencies: [{ name: 'System Design', score: 91 }, { name: 'APIs', score: 79 }],
    evidence: { assessments: 14, capstonesGraded: 3, interviews: 2, coveragePct: 92 },
    achieved: true, verified: true, proofToken: 'SECRETTOKEN', lastActiveAt: new Date() },
};

ok('anonHandle is stable + 4-digit', () => {
  const h1 = anonHandle('0123456789abcdef01234567'); const h2 = anonHandle('0123456789abcdef01234567');
  assert.strictEqual(h1, h2);
  assert.ok(/^Candidate #\d{4}$/.test(h1));
});
ok('browse card has no PII', () => {
  const c = toBrowseCard(profile);
  const json = JSON.stringify(c);
  assert.ok(!json.includes('USERSECRET'));
  assert.ok(!json.includes('SECRETTOKEN'));
  assert.strictEqual(c.handle, anonHandle(profile._id));
  assert.strictEqual(c.band, 'Exceptional');
  assert.strictEqual(c.score, 88);
  assert.strictEqual(c.achieved, true);
  assert.strictEqual(c.verified, true);
  assert.strictEqual(c.city, 'Bangalore');
  assert.ok(Array.isArray(c.skills) && c.skills.includes('System Design'));
  assert.ok(typeof c.whySummary === 'string' && c.whySummary.length > 0);
});
ok('anonymized profile has competencies + why, no PII/token', () => {
  const p = toAnonymizedProfile(profile);
  const json = JSON.stringify(p);
  assert.ok(!json.includes('USERSECRET'));
  assert.ok(!json.includes('SECRETTOKEN'));
  assert.strictEqual(p.competencies.length, 2);
  assert.strictEqual(p.evidence.assessments, 14);
  assert.ok(Array.isArray(p.why) && p.why[0].key === 'achieved');
  assert.strictEqual(p.handle, anonHandle(profile._id));
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/services/employer/talentAnonymizer.js
'use strict';
const ranking = require('./talentRankingService');

// Stable pseudonymous handle from the profile id. Deterministic, non-reversible to PII.
function anonHandle(id) {
  const hex = String(id || '').replace(/[^0-9a-f]/gi, '').slice(-6) || '0';
  const n = (parseInt(hex, 16) % 9000) + 1000; // 1000..9999
  return `Candidate #${n}`;
}

function _whySummary(profile) {
  const sigs = ranking.explain(profile);
  if (!sigs.length) return 'In the pool for this role.';
  return sigs.slice(0, 3).map((s) => s.label).join(' · ');
}

// Search-row card. NO name, userId, contact, or proof token.
function toBrowseCard(profile) {
  const s = profile.snapshot || {};
  return {
    handle: anonHandle(profile._id),
    roleLabel: s.roleLabel || null,
    band: s.readinessBand || null,
    score: s.readinessScore ?? null,
    target: s.target ?? null,
    achieved: !!s.achieved,
    verified: !!s.verified,
    city: profile.city || null,
    noticePeriod: profile.noticePeriod || null,
    workPref: profile.workPref || 'any',
    skills: (s.competencies || []).map((c) => c.name).slice(0, 6),
    coveragePct: s.evidence?.coveragePct ?? null,
    whySummary: _whySummary(profile),
  };
}

// Fuller anonymized profile (competency scores, evidence, full why). Still NO PII/token.
function toAnonymizedProfile(profile) {
  const s = profile.snapshot || {};
  return {
    handle: anonHandle(profile._id),
    roleLabel: s.roleLabel || null,
    objectiveType: s.objectiveType || null,
    targetCompany: s.targetCompany || null,
    band: s.readinessBand || null,
    score: s.readinessScore ?? null,
    target: s.target ?? null,
    achieved: !!s.achieved,
    verified: !!s.verified,
    city: profile.city || null,
    noticePeriod: profile.noticePeriod || null,
    workPref: profile.workPref || 'any',
    competencies: (s.competencies || []).map((c) => ({ name: c.name, score: c.score })),
    evidence: {
      assessments: s.evidence?.assessments || 0,
      capstonesGraded: s.evidence?.capstonesGraded || 0,
      interviews: s.evidence?.interviews || 0,
      coveragePct: s.evidence?.coveragePct ?? null,
    },
    codingMastery: s.codingMastery || null,
    why: ranking.explain(profile),
  };
}

module.exports = { anonHandle, toBrowseCard, toAnonymizedProfile };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/talentAnonymizer.js src/test/employer/anonymizer.test.js
git commit -m "feat(employer): PII-stripped talent projections (browse card + anon profile) (Phase 2)"
```

---

## Task 4: `employerSearchService.buildQuery` — filters → Mongo query

**Files:**
- Create: `src/services/employer/employerSearchService.js`
- Test: `src/test/employer/searchQuery.test.js`

Translate recruiter filters into a Mongo query over `TalentProfile`. ALWAYS constrains to `optedIn:true, status:'active'` (the pool floor). Filters are optional/additive.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/searchQuery.test.js
'use strict';
const assert = require('assert');
const { buildQuery } = require('../../services/employer/employerSearchService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('always constrains to opted-in active', () => {
  const q = buildQuery({});
  assert.strictEqual(q.optedIn, true);
  assert.strictEqual(q.status, 'active');
});
ok('band filter -> $in on readinessBand', () => {
  const q = buildQuery({ bands: ['Strong', 'Exceptional'] });
  assert.deepStrictEqual(q['snapshot.readinessBand'], { $in: ['Strong', 'Exceptional'] });
});
ok('role filter -> objectiveType', () => {
  const q = buildQuery({ objectiveType: 'interview_preparation' });
  assert.strictEqual(q['snapshot.objectiveType'], 'interview_preparation');
});
ok('skills -> $in on competency names', () => {
  const q = buildQuery({ skills: ['System Design'] });
  assert.deepStrictEqual(q['snapshot.competencies.name'], { $in: ['System Design'] });
});
ok('city -> case-insensitive exact', () => {
  const q = buildQuery({ city: 'bangalore' });
  assert.ok(q.city instanceof RegExp);
  assert.ok(q.city.test('Bangalore'));
});
ok('proof verified -> snapshot.verified true', () => {
  assert.strictEqual(buildQuery({ proof: 'verified' })['snapshot.verified'], true);
});
ok('proof achieved -> snapshot.achieved true', () => {
  assert.strictEqual(buildQuery({ proof: 'achieved' })['snapshot.achieved'], true);
});
ok('ignores unknown/empty filters', () => {
  const q = buildQuery({ bands: [], skills: [], city: '' });
  assert.ok(!('snapshot.readinessBand' in q));
  assert.ok(!('city' in q));
});
console.log(`# tests 8\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/services/employer/employerSearchService.js
'use strict';
const ranking = require('./talentRankingService');
const anonymizer = require('./talentAnonymizer');

function _escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Recruiter filters -> Mongo query. Always floored to the opted-in active pool.
function buildQuery(filters = {}) {
  const q = { optedIn: true, status: 'active' };
  if (Array.isArray(filters.bands) && filters.bands.length) q['snapshot.readinessBand'] = { $in: filters.bands };
  if (filters.objectiveType) q['snapshot.objectiveType'] = filters.objectiveType;
  if (filters.roleLabel) q['snapshot.roleLabel'] = new RegExp(_escapeRegex(filters.roleLabel), 'i');
  if (filters.targetCompany) q['snapshot.targetCompany'] = new RegExp(_escapeRegex(filters.targetCompany), 'i');
  if (Array.isArray(filters.skills) && filters.skills.length) q['snapshot.competencies.name'] = { $in: filters.skills };
  if (filters.city) q.city = new RegExp('^' + _escapeRegex(filters.city) + '$', 'i');
  if (filters.workPref && filters.workPref !== 'any') q.workPref = { $in: [filters.workPref, 'any', 'hybrid'] };
  if (filters.proof === 'verified') q['snapshot.verified'] = true;
  if (filters.proof === 'achieved') q['snapshot.achieved'] = true;
  return q;
}

module.exports = { buildQuery };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/employerSearchService.js src/test/employer/searchQuery.test.js
git commit -m "feat(employer): search query builder over talent pool (Phase 2)"
```

---

## Task 5: `employerSearchService.search` + `getCandidate`

**Files:**
- Modify: `src/services/employer/employerSearchService.js`
- Test: `src/test/employer/search.test.js`

`search(filters)` → query the model, rank, map to browse cards, cap at a page size. `getCandidate(id)` → load one opted-in active profile, return the anonymized profile (or null). DB access via the `_find` / `_findOne` seams.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/search.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/employerSearchService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

const mk = (id, p) => ({ _id: id, city: 'Bangalore', snapshot: { roleLabel: 'Backend Engineer', readinessBand: 'Strong', readinessScore: 80,
  competencies: [{ name: 'System Design', score: 80 }], evidence: { assessments: 3, coveragePct: 60 }, achieved: false, verified: false, lastActiveAt: new Date('2020-01-01'), ...p } });

(async () => {
  await ok('search ranks + returns browse cards (achiever first)', async () => {
    svc._find = async () => [ mk('aaaa000000000000aaaa0001', {}), mk('bbbb000000000000bbbb0002', { achieved: true }) ];
    const out = await svc.search({});
    assert.strictEqual(out.total, 2);
    assert.strictEqual(out.results[0].achieved, true); // ranked first
    assert.ok(out.results[0].handle.startsWith('Candidate #'));
    assert.ok(!JSON.stringify(out.results).includes('_id')); // no raw id leaked
  });

  await ok('search respects page cap', async () => {
    const many = Array.from({ length: 60 }, (_, i) => mk(String(i).padStart(24, '0'), {}));
    svc._find = async () => many;
    const out = await svc.search({}, { limit: 25 });
    assert.strictEqual(out.results.length, 25);
    assert.strictEqual(out.total, 60);
  });

  await ok('getCandidate returns anonymized profile', async () => {
    svc._findOne = async () => mk('cccc000000000000cccc0003', { verified: true });
    const p = await svc.getCandidate('cccc000000000000cccc0003');
    assert.strictEqual(p.verified, true);
    assert.ok(Array.isArray(p.why));
    assert.ok(p.handle.startsWith('Candidate #'));
  });

  await ok('getCandidate null when not found / not in pool', async () => {
    svc._findOne = async () => null;
    assert.strictEqual(await svc.getCandidate('x'), null);
  });

  console.log(`# tests 4\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement (append to `employerSearchService.js`)**

```js
const DEFAULT_LIMIT = 25;

async function _find(query) {
  const TalentProfile = require('../../models/TalentProfile');
  return TalentProfile.find(query).lean();
}
async function _findOne(id) {
  const TalentProfile = require('../../models/TalentProfile');
  return TalentProfile.findOne({ _id: id, optedIn: true, status: 'active' }).lean();
}

// Filter -> query -> rank -> anonymized browse cards (paged).
async function search(filters = {}, opts = {}) {
  const limit = Math.max(1, Math.min(100, opts.limit || DEFAULT_LIMIT));
  const rows = await module.exports._find(buildQuery(filters));
  const ranked = ranking.rank(rows);
  return { total: ranked.length, results: ranked.slice(0, limit).map(anonymizer.toBrowseCard) };
}

// One candidate's anonymized profile (only if still in the pool).
async function getCandidate(id) {
  const row = await module.exports._findOne(id);
  if (!row) return null;
  return anonymizer.toAnonymizedProfile(row);
}

module.exports.search = search;
module.exports.getCandidate = getCandidate;
module.exports._find = _find;
module.exports._findOne = _findOne;
```

- [ ] **Step 4: Run it — expect PASS.** Re-run Task 4's test (no regression).

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/employerSearchService.js src/test/employer/search.test.js
git commit -m "feat(employer): search() + getCandidate() ranked anonymized results (Phase 2)"
```

---

## Task 6: Employer discovery routes

**Files:**
- Create: `src/routes/employer/search.js`
- Modify: `src/app.js`
- Test: `src/test/employer/searchRoutes.test.js`

`GET /api/employer/search` (query params → filters), `GET /api/employer/candidates/:id`. Both behind `flagGuard` + `employerAuth` (a valid token = browse tier). Handlers exported for unit testing.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/searchRoutes.test.js
'use strict';
const assert = require('assert');
const h = require('../../routes/employer/search');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function res(){ return { code:200, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  h._svc.search = async (filters) => ({ total: 1, results: [{ handle: 'Candidate #1234' }], echo: filters });
  await ok('search handler parses query into filters', async () => {
    const r = res();
    await h.searchHandler({ query: { bands: 'Strong,Exceptional', skills: 'System Design', city: 'Bangalore', proof: 'verified' } }, r);
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.body.data.echo.bands, ['Strong', 'Exceptional']);
    assert.deepStrictEqual(r.body.data.echo.skills, ['System Design']);
    assert.strictEqual(r.body.data.echo.proof, 'verified');
    assert.strictEqual(r.body.data.results[0].handle, 'Candidate #1234');
  });

  h._svc.getCandidate = async () => ({ handle: 'Candidate #1234', why: [] });
  await ok('candidate handler 200', async () => {
    const r = res();
    await h.candidateHandler({ params: { id: 'abc' } }, r);
    assert.strictEqual(r.body.data.handle, 'Candidate #1234');
  });
  await ok('candidate 404 when null', async () => {
    h._svc.getCandidate = async () => null;
    const r = res();
    await h.candidateHandler({ params: { id: 'gone' } }, r);
    assert.strictEqual(r.code, 404);
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/routes/employer/search.js
'use strict';
const router = require('express').Router();
const featureFlags = require('../../config/featureFlags');
const { employerAuth } = require('../../middleware/employerAuth');
const svc = require('../../services/employer/employerSearchService');

function flagGuard(req, res, next) {
  if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
  return next();
}
function _csv(v) { return typeof v === 'string' && v.length ? v.split(',').map((x) => x.trim()).filter(Boolean) : []; }

async function searchHandler(req, res) {
  try {
    const q = req.query || {};
    const filters = {
      bands: _csv(q.bands), skills: _csv(q.skills),
      objectiveType: q.objectiveType || undefined, roleLabel: q.roleLabel || undefined,
      targetCompany: q.targetCompany || undefined, city: q.city || undefined,
      workPref: q.workPref || undefined, proof: q.proof || undefined,
    };
    const limit = q.limit ? parseInt(q.limit, 10) : undefined;
    return res.status(200).json({ success: true, data: await svc.search(filters, { limit }) });
  } catch (err) { console.error('[employer/search]', err.message); return res.status(500).json({ success: false, message: 'Search failed.' }); }
}
async function candidateHandler(req, res) {
  try {
    const p = await svc.getCandidate(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Candidate not found or no longer available.' });
    return res.status(200).json({ success: true, data: p });
  } catch (err) { console.error('[employer/candidate]', err.message); return res.status(500).json({ success: false, message: 'Could not load candidate.' }); }
}

router.get('/search', flagGuard, employerAuth, searchHandler);
router.get('/candidates/:id', flagGuard, employerAuth, candidateHandler);

module.exports = router;
module.exports.searchHandler = searchHandler;
module.exports.candidateHandler = candidateHandler;
module.exports.flagGuard = flagGuard;
module.exports._svc = svc;
```

- [ ] **Step 4: Mount in `src/app.js`** (after the `/api/employer/auth` mount):

```js
app.use('/api/employer', require('./routes/employer/search'));
```

- [ ] **Step 5: Run it — expect PASS.** Confirm load: `node -e "require('./src/routes/employer/search'); console.log('ok')"`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/employer/search.js src/app.js src/test/employer/searchRoutes.test.js
git commit -m "feat(employer): /api/employer/search + /candidates/:id routes (Phase 2)"
```

---

## Task 7: Suite green + push

- [ ] **Step 1: Run the whole employer suite**

```bash
for f in src/test/employer/*.test.js; do printf "%-34s " "$(basename $f)"; node "$f" 2>&1 | grep -E "# (tests|pass|fail)" | tr '\n' ' '; echo; done
```
Expected: every file `# fail 0` (Phase 1 + Phase 2 tests).

- [ ] **Step 2: Parse + route-load**

```bash
for f in src/services/employer/*.js src/routes/employer/search.js src/app.js; do node --check "$f" || echo "FAIL $f"; done && echo PARSE_OK
node -e "require('./src/routes/employer/search'); console.log('routes load')"
```

- [ ] **Step 3: Push**

```bash
git push origin master
```

---

## Self-Review (done by plan author)

**Spec coverage (Phase 2):** search/filter axes (Task 4 ✓ role/company/band/skills/location/workPref/proof), deterministic ranking Achieved→Verified→Band→Score→Evidence→Recency (Task 1 ✓), explainability (Task 2 ✓), anonymized browse card + anon profile with no PII before connection (Task 3 ✓ — tests assert userId/proofToken never serialized), employer-auth-gated routes (Task 6 ✓, browse tier = valid token), flag-gated (Task 6 `flagGuard` ✓). Connection flow + real proof-badge reveal = Phase 3; web UI = Phase 4.

**Placeholder scan:** none — every step has complete runnable code.

**Type/name consistency:** reads exactly the Phase-1 `snapshot` shape (`readinessBand`, `readinessScore`, `competencies[].name`, `evidence.coveragePct`, `achieved`, `verified`, `lastActiveAt`). `scoreOne`/`rank`/`explain` signatures consistent across Tasks 1–2 and consumed unchanged in Tasks 3, 5. `toBrowseCard`/`toAnonymizedProfile`/`anonHandle` consistent across Tasks 3, 5. `_svc`/`_find`/`_findOne` stub seams consistent.

**Note for executor:** Phase 2 is read-only over the pool — no writes, additive, flag-off by default. The anonymizer PII tests are the security backbone; do not weaken them.
