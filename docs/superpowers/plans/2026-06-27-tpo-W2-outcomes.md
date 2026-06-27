# TPO Portal W2 — Placement Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the TPO record placement offers (student → company → CTC → status) and see the numbers Indian colleges report and market on — **placement %, highest / average / median package (LPA), companies visited, branch-wise placed** — turning ScaleUp from an assessment tool into a placement-management platform.

**Architecture:** New additive `PlacementOffer` Mongo model + an `outcomeService` and `src/routes/institution/outcomes.js` router (CRUD offers, bulk CSV import, cohort outcomes summary, institution rollup), all institution-scoped + role-gated like the existing routes. A new `/org/outcomes` page in the portal (built on the W1 `_ui` kit) records/imports offers and renders the summary; the sidebar "Outcomes" nav points at it.

**Tech Stack:** Backend — Node/Express/Mongoose; tests `node:test` + `supertest` + `router._deps` DI stubs. Web — Next.js/React/TS using `app/org/_ui.tsx`.

## Global Constraints

- **Zero D2C impact.** Additive model + routes; institution-scoped (`institutionScope`, institutionId from token); writes gated `institution_admin`/`tpo_head`/`tpo_coordinator`; reads any institution role. No D2C changes.
- **Field whitelist on writes** (no mass-assigning `institutionId`/`cohortId`/`_id`/`createdBy`).
- **Backend tests:** `node --test <file>` (node v20 via nvm; else `~/.nvm/versions/node/v20.20.0/bin/node --test <file>`).
- **Deploy:** backend push `master`; web git-less Vercel.
- **Outcomes math (authoritative):** cohort size = enrollment count for the cohort; **placed students = distinct (rollNumber, else studentName) among offers with status in {accepted, joined}**; **placement % = round(placed ÷ cohortSize × 100)** (0 if cohortSize 0); package stats (**highest / average / median CTC**) computed over the **placed** offers that have a numeric `ctc`; **companies visited = distinct companyName across ALL offers**; **branch-wise = count of placed offers grouped by `branch`**; plus offer-status counts.
- **Contract (web depends on these):**
  - `POST/GET/PATCH/DELETE /api/institution/cohorts/:cohortId/offers`
  - `POST /api/institution/cohorts/:cohortId/offers/import` body `{ rows: OfferRow[] }` → `{ success, data: { created } }`
  - `GET /api/institution/cohorts/:cohortId/outcomes` → `{ success, data: OutcomeSummary }`
  - `GET /api/institution/outcomes` → `{ success, data: { cohorts: [{ cohortId, label?, summary }], institution: OutcomeSummary } }`
  - `PlacementOffer` JSON: `{ _id, cohortId, studentName, rollNumber?, branch?, companyName, role?, ctc?, offerType, status, offerDate?, notes?, createdAt }`.
  - `OutcomeSummary` = `{ cohortSize, placedCount, placementPercent, highestCtc, averageCtc, medianCtc, companiesVisited, statusCounts: {offered,accepted,joined,declined}, branchWise: [{ branch, placed }] }`.

---

## File Structure

**Backend:** `src/models/PlacementOffer.js`; `src/services/institution/outcomeService.js`; `src/routes/institution/outcomes.js`; mount in `src/routes/institution/index.js`. Tests: `src/test/institution/placementOffer.model.test.js`, `outcomes.route.test.js`, `outcomeService.test.js`.

**Web:** `lib/institutionClient.ts` (types + methods); `app/org/outcomes/page.tsx` (new).

---

## Task 1: Backend — PlacementOffer model

**Files:** Create `src/models/PlacementOffer.js`; Test `src/test/institution/placementOffer.model.test.js`.

**Interfaces:** required `institutionId`,`cohortId`,`studentName`,`companyName`; `offerType` enum `['full_time','internship']` default `'full_time'`; `status` enum `['offered','accepted','joined','declined']` default `'offered'`; optional `rollNumber`,`branch`,`role`,`ctc`(Number),`offerDate`(Date),`driveId`,`enrollmentId`,`notes`,`createdBy`; timestamps.

- [ ] **Step 1: Failing test.**
```js
'use strict';
const test = require('node:test'); const assert = require('node:assert');
const PlacementOffer = require('../../models/PlacementOffer');
const oid = '507f1f77bcf86cd799439011';
test('PlacementOffer requires institutionId, cohortId, studentName, companyName', () => {
  const e = new PlacementOffer({}).validateSync();
  assert.ok(e.errors.institutionId && e.errors.cohortId && e.errors.studentName && e.errors.companyName);
});
test('PlacementOffer defaults offerType=full_time, status=offered; validates enums', () => {
  const o = new PlacementOffer({ institutionId: oid, cohortId: oid, studentName: 'A', companyName: 'Acme' });
  assert.strictEqual(o.offerType, 'full_time'); assert.strictEqual(o.status, 'offered');
  assert.ok(new PlacementOffer({ institutionId: oid, cohortId: oid, studentName: 'A', companyName: 'X', status: 'nope' }).validateSync().errors.status);
});
test('PlacementOffer keeps ctc + branch', () => {
  const o = new PlacementOffer({ institutionId: oid, cohortId: oid, studentName: 'A', companyName: 'X', ctc: 18, branch: 'CSE', status: 'accepted' });
  assert.strictEqual(o.ctc, 18); assert.strictEqual(o.branch, 'CSE');
});
```

- [ ] **Step 2: Run → FAIL.** `node --test src/test/institution/placementOffer.model.test.js`

- [ ] **Step 3: Implement `src/models/PlacementOffer.js`.**
```js
const mongoose = require('mongoose');
const PlacementOfferSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true, index: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionEnrollment' },
  studentName: { type: String, required: true, trim: true },
  rollNumber: { type: String, trim: true },
  branch: { type: String, trim: true },
  companyName: { type: String, required: true, trim: true },
  driveId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlacementDrive' },
  role: { type: String, trim: true },
  ctc: { type: Number },                 // LPA
  offerType: { type: String, enum: ['full_time', 'internship'], default: 'full_time' },
  status: { type: String, enum: ['offered', 'accepted', 'joined', 'declined'], default: 'offered' },
  offerDate: { type: Date },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });
PlacementOfferSchema.index({ institutionId: 1, cohortId: 1, status: 1 });
module.exports = mongoose.models.PlacementOffer || mongoose.model('PlacementOffer', PlacementOfferSchema);
```

- [ ] **Step 4: Run → PASS (3).**

- [ ] **Step 5: Commit.** `git add src/models/PlacementOffer.js src/test/institution/placementOffer.model.test.js && git commit -m "Placement outcomes: PlacementOffer model"`

---

## Task 2: Backend — outcomeService (summary math) + routes

**Files:** Create `src/services/institution/outcomeService.js`, `src/routes/institution/outcomes.js`; Modify `src/routes/institution/index.js`; Tests `src/test/institution/outcomeService.test.js`, `src/test/institution/outcomes.route.test.js`.

**Interfaces:**
- Service: `createOffer(scope, cohortId, body, deps)`, `listOffers(scope, cohortId, deps)`, `updateOffer(scope, cohortId, offerId, body, deps)` (404 `OFFER_NOT_FOUND`), `deleteOffer(scope, cohortId, offerId, deps)` (404), `importOffers(scope, cohortId, rows, deps)` (→ `{ created }`), `cohortOutcomes(scope, cohortId, deps)` (→ `OutcomeSummary`), `institutionOutcomes(scope, deps)` (→ `{ cohorts, institution }`). Whitelist `{ studentName, rollNumber, branch, companyName, role, ctc, offerType, status, offerDate, driveId, notes }`. `summarize(offers, cohortSize)` is a PURE helper exported for testing.
- Routes: the 6 endpoints in the contract; writes gated to admin/tpo_head/tpo_coordinator, reads any role.

- [ ] **Step 1: Failing service test** (pure math — no DB). `src/test/institution/outcomeService.test.js`:
```js
'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { summarize } = require('../../services/institution/outcomeService');
test('summarize computes placement %, package stats, companies, branch-wise', () => {
  const offers = [
    { rollNumber: 'R1', branch: 'CSE', companyName: 'Acme', ctc: 30, status: 'accepted' },
    { rollNumber: 'R2', branch: 'CSE', companyName: 'Acme', ctc: 12, status: 'joined' },
    { rollNumber: 'R3', branch: 'ECE', companyName: 'Globex', ctc: 18, status: 'offered' }, // not placed
    { rollNumber: 'R1', branch: 'CSE', companyName: 'Initech', ctc: 24, status: 'declined' }, // dup student, not placed
  ];
  const s = summarize(offers, 4); // cohortSize 4
  assert.strictEqual(s.placedCount, 2);            // R1(accepted), R2(joined)
  assert.strictEqual(s.placementPercent, 50);      // 2/4
  assert.strictEqual(s.highestCtc, 30);
  assert.strictEqual(s.averageCtc, 21);            // (30+12)/2
  assert.strictEqual(s.medianCtc, 21);             // median of [12,30]
  assert.strictEqual(s.companiesVisited, 3);       // Acme, Globex, Initech
  assert.deepStrictEqual(s.statusCounts, { offered: 1, accepted: 1, joined: 1, declined: 1 });
  assert.deepStrictEqual(s.branchWise, [{ branch: 'CSE', placed: 2 }]); // only placed grouped
  assert.strictEqual(s.cohortSize, 4);
});
test('summarize handles empty + zero cohort', () => {
  const s = summarize([], 0);
  assert.strictEqual(s.placementPercent, 0); assert.strictEqual(s.placedCount, 0);
  assert.strictEqual(s.highestCtc, null); assert.deepStrictEqual(s.branchWise, []);
});
```

- [ ] **Step 2: Failing route test** `src/test/institution/outcomes.route.test.js` (copy `org.route.test.js` helpers; mount `require('../../routes/institution/outcomes')` as `outcomes`):
```js
test('viewer cannot create an offer (403)', async () => {
  const res = await request(appAs('inst-A','viewer')).post('/api/institution/cohorts/c1/offers')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`).send({ studentName: 'A', companyName: 'X' });
  assert.strictEqual(res.status, 403); outcomes._deps = null;
});
test('tpo_head creates offer; scope from token, cohort from path', async () => {
  let cap = null;
  outcomes._deps = { outcomeService: { createOffer: async (scope, cohortId, body) => { cap = { scope, cohortId, body }; return { _id: 'o1', ...body }; } } };
  const res = await request(appAs('inst-A','tpo_head')).post('/api/institution/cohorts/c1/offers')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`).send({ studentName: 'A', companyName: 'Acme', ctc: 18, institutionId: 'EVIL' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(cap.scope.institutionId, 'inst-A'); assert.strictEqual(cap.cohortId, 'c1'); assert.strictEqual(cap.body.companyName, 'Acme');
  outcomes._deps = null;
});
test('GET cohort outcomes (any role)', async () => {
  outcomes._deps = { outcomeService: { cohortOutcomes: async () => ({ cohortSize: 4, placedCount: 2, placementPercent: 50, highestCtc: 30, averageCtc: 21, medianCtc: 21, companiesVisited: 3, statusCounts: {}, branchWise: [] }) } };
  const res = await request(appAs('inst-A','viewer')).get('/api/institution/cohorts/c1/outcomes')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`);
  assert.strictEqual(res.status, 200); assert.strictEqual(res.body.data.placementPercent, 50); outcomes._deps = null;
});
test('PATCH unknown offer → 404', async () => {
  outcomes._deps = { outcomeService: { updateOffer: async () => { throw new Error('OFFER_NOT_FOUND'); } } };
  const res = await request(appAs('inst-A','tpo_head')).patch('/api/institution/cohorts/c1/offers/oX')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`).send({ status: 'joined' });
  assert.strictEqual(res.status, 404); outcomes._deps = null;
});
```

- [ ] **Step 3: Run both → FAIL.**

- [ ] **Step 4: Implement the service.** `src/services/institution/outcomeService.js` — include a PURE `summarize(offers, cohortSize)`:
```js
'use strict';
const FIELDS = ['studentName','rollNumber','branch','companyName','role','ctc','offerType','status','offerDate','driveId','notes'];
function pick(b = {}) { const o = {}; for (const k of FIELDS) if (b[k] !== undefined) o[k] = b[k]; return o; }
function median(nums) { if (!nums.length) return null; const s = [...nums].sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : Math.round((s[m-1]+s[m])/2); }
function studentKey(o) { return o.rollNumber ? `r:${o.rollNumber}` : `n:${o.studentName}`; }
function summarize(offers, cohortSize) {
  const placedOffers = offers.filter((o) => o.status === 'accepted' || o.status === 'joined');
  const placedKeys = new Set(placedOffers.map(studentKey));
  const placedCount = placedKeys.size;
  const placementPercent = cohortSize > 0 ? Math.round((placedCount / cohortSize) * 100) : 0;
  const ctcs = placedOffers.map((o) => o.ctc).filter((c) => typeof c === 'number');
  const highestCtc = ctcs.length ? Math.max(...ctcs) : null;
  const averageCtc = ctcs.length ? Math.round(ctcs.reduce((a,b)=>a+b,0) / ctcs.length) : null;
  const medianCtc = median(ctcs);
  const companiesVisited = new Set(offers.map((o) => (o.companyName||'').trim().toLowerCase()).filter(Boolean)).size;
  const statusCounts = { offered: 0, accepted: 0, joined: 0, declined: 0 };
  for (const o of offers) if (statusCounts[o.status] !== undefined) statusCounts[o.status]++;
  const branchMap = {};
  for (const o of placedOffers) { const b = o.branch && o.branch.trim(); if (b) branchMap[b] = (branchMap[b]||0); }
  // count distinct placed students per branch
  const seenByBranch = {};
  for (const o of placedOffers) { const b = o.branch && o.branch.trim(); if (!b) continue; (seenByBranch[b] ||= new Set()).add(studentKey(o)); }
  const branchWise = Object.keys(seenByBranch).map((b) => ({ branch: b, placed: seenByBranch[b].size })).sort((a,b)=>b.placed-a.placed);
  return { cohortSize, placedCount, placementPercent, highestCtc, averageCtc, medianCtc, companiesVisited, statusCounts, branchWise };
}
function models(deps) {
  return {
    Offer: (deps && deps.PlacementOffer) || require('../../models/PlacementOffer'),
    Enrollment: (deps && deps.InstitutionEnrollment) || require('../../models/InstitutionEnrollment'),
    Cohort: (deps && deps.InstitutionCohort) || require('../../models/InstitutionCohort'),
  };
}
async function createOffer(scope, cohortId, body, deps) { const { Offer } = models(deps); return Offer.create({ ...scope, cohortId, ...pick(body) }); }
async function listOffers(scope, cohortId, deps) { const { Offer } = models(deps); const q = Offer.find({ ...scope, cohortId }).sort({ createdAt: -1 }).limit(2000); return typeof q.lean === 'function' ? q.lean() : q; }
async function updateOffer(scope, cohortId, offerId, body, deps) { const { Offer } = models(deps); const o = await Offer.findOneAndUpdate({ ...scope, cohortId, _id: offerId }, { $set: pick(body) }, { new: true }); if (!o) throw new Error('OFFER_NOT_FOUND'); return o; }
async function deleteOffer(scope, cohortId, offerId, deps) { const { Offer } = models(deps); const o = await Offer.findOneAndDelete({ ...scope, cohortId, _id: offerId }); if (!o) throw new Error('OFFER_NOT_FOUND'); return o; }
async function importOffers(scope, cohortId, rows, deps) { const { Offer } = models(deps); const docs = (rows||[]).filter((r)=>r && r.studentName && r.companyName).map((r)=>({ ...scope, cohortId, ...pick(r) })); if (!docs.length) return { created: 0 }; const res = await Offer.insertMany(docs); return { created: res.length }; }
async function cohortOutcomes(scope, cohortId, deps) {
  const { Offer, Enrollment } = models(deps);
  const oq = Offer.find({ ...scope, cohortId }); const offers = typeof oq.lean === 'function' ? await oq.lean() : await oq;
  const cohortSize = await Enrollment.countDocuments({ ...scope, cohortId });
  return summarize(offers, cohortSize);
}
async function institutionOutcomes(scope, deps) {
  const { Offer, Enrollment, Cohort } = models(deps);
  const cq = Cohort.find({ ...scope }); const cohorts = typeof cq.lean === 'function' ? await cq.lean() : await cq;
  const oq = Offer.find({ ...scope }); const allOffers = typeof oq.lean === 'function' ? await oq.lean() : await oq;
  const totalEnroll = await Enrollment.countDocuments({ ...scope });
  const perCohort = [];
  for (const c of cohorts) {
    const offers = allOffers.filter((o) => String(o.cohortId) === String(c._id));
    const size = await Enrollment.countDocuments({ ...scope, cohortId: c._id });
    perCohort.push({ cohortId: String(c._id), label: c.label, summary: summarize(offers, size) });
  }
  return { cohorts: perCohort, institution: summarize(allOffers, totalEnroll) };
}
module.exports = { summarize, createOffer, listOffers, updateOffer, deleteOffer, importOffers, cohortOutcomes, institutionOutcomes };
```
(Confirm `InstitutionEnrollment.countDocuments({ ...scope, cohortId })` — the enrollment model carries `institutionId` (verified in W-phase 3 work); keep the scope filter.)

- [ ] **Step 5: Implement the routes** `src/routes/institution/outcomes.js` (mirror `notices.js`: `router._deps`, `getService`, `institutionAuth`, `WRITE = requireInstitutionRole('institution_admin','tpo_head','tpo_coordinator')`, `institutionScope`; map `OFFER_NOT_FOUND`→404, ValidationError/CastError→400):
  - `POST /cohorts/:cohortId/offers` (WRITE) 201 createOffer
  - `GET /cohorts/:cohortId/offers` (any) 200 listOffers
  - `PATCH /cohorts/:cohortId/offers/:offerId` (WRITE) 200 updateOffer
  - `DELETE /cohorts/:cohortId/offers/:offerId` (WRITE) 200 deleteOffer
  - `POST /cohorts/:cohortId/offers/import` (WRITE) 200 importOffers(req.body.rows)
  - `GET /cohorts/:cohortId/outcomes` (any) 200 cohortOutcomes
  - `GET /outcomes` (any) 200 institutionOutcomes
  Mount in `src/routes/institution/index.js`: `router.use('/', require('./outcomes'));`.

- [ ] **Step 6: Run both test files → PASS** (service 2, route 4). Then full suite `node --test src/test/institution/*.test.js` green.

- [ ] **Step 7: Commit + push.** `git add src/services/institution/outcomeService.js src/routes/institution/outcomes.js src/routes/institution/index.js src/test/institution/outcomeService.test.js src/test/institution/outcomes.route.test.js && git commit -m "Placement outcomes: offers CRUD + import + cohort/institution summary (scoped, role-gated)" && git push origin master`

---

## Task 3: Web — Outcomes page

**Files:** Modify `lib/institutionClient.ts`; Create `app/org/outcomes/page.tsx`.

**Interfaces:** Add types `PlacementOffer`, `OutcomeSummary`, `InstitutionOutcomes` + methods `listOffers(cohortId)`, `createOffer(cohortId, body)`, `updateOffer(cohortId, offerId, body)`, `deleteOffer(cohortId, offerId)`, `importOffers(cohortId, rows)`, `cohortOutcomes(cohortId)`, `institutionOutcomes()`. Mirror the existing client method style.

- [ ] **Step 1: Add types + methods** to `lib/institutionClient.ts` (mirror drives/notices). `OutcomeSummary` per the contract.

- [ ] **Step 2: Build `app/org/outcomes/page.tsx`** using the W1 `_ui` kit: a `PageHeader` ("Placement outcomes"); an **institution rollup** band of `StatCard`s (placement %, highest/avg/median package in LPA, companies visited) from `institutionOutcomes()`; a **cohort picker** (from `listCohorts()`); for the selected cohort — the cohort `OutcomeSummary` (`StatCard`s + a small branch-wise list), a `DataTable` of offers (student, company, role, CTC, status `Badge`, with edit/delete for managers), an "Add offer" `Modal` form (student name + roll + branch + company + role + CTC + offer type + status + date), and a "Bulk import" affordance (paste CSV: `studentName,rollNumber,branch,companyName,role,ctc,status` → parse client-side to rows → `importOffers`). Manager-gated writes (admin/tpo_head/tpo_coordinator). Empty states with directive copy. Refresh summary after mutations.

- [ ] **Step 3: Build-verify.** `cd "/Users/nirpekshnandan/My Products/scaleup-web" && npx next build 2>&1 | grep -iE "error|Compiled successfully" | head` → "Compiled successfully".

- [ ] **Step 4: Deploy + commit.**
```
SRC="/Users/nirpekshnandan/My Products/scaleup-web"; rm -rf /tmp/sw-deploy && rsync -a --exclude=.git --exclude=node_modules --exclude=.next "$SRC/" /tmp/sw-deploy/ && cd /tmp/sw-deploy && npx vercel --prod --yes 2>&1 | grep -iE "Production|Aliased" | head
cd "$SRC" && git add lib/institutionClient.ts app/org/outcomes/page.tsx && git commit -m "TPO portal: Placement outcomes page (offers + placement %/package stats)"
```

---

## Final steps

- [ ] Confirm box on the new backend commit + pm2 online.
- [ ] Confirm the sidebar "Outcomes" nav reaches `/org/outcomes` (W1 left it as a placeholder; if it doesn't already point there, update the nav target in `_ui.tsx`).
- [ ] Report: the TPO can record/import offers and see placement % + package stats per cohort and institution-wide. W3 (Dashboard) consumes `institutionOutcomes()`.

## Self-Review notes (addressed)

- **Spec coverage:** Part 3 (Placement Outcomes) fully covered — model (T1), summary math + CRUD/import/rollup endpoints (T2), the Outcomes page (T3). The cohort-workspace Outcomes *stage* is W4; this ships a standalone `/org/outcomes` now.
- **Math is pure + tested:** `summarize` is a pure function with explicit unit tests (placement %, median/avg/highest, distinct-student dedup by roll, companies, branch-wise, empty/zero-cohort).
- **Scope isolation:** every query filtered by `{ ...scope, cohortId }`; writes whitelist fields + role-gated; route tests assert scope-from-token + 403 + 404.
- **Type consistency:** `PlacementOffer` + `OutcomeSummary` shapes identical across backend, client types, and the page.
