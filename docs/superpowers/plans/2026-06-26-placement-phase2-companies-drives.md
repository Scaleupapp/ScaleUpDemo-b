# Placement Phase 2 — Companies & Drives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the TPO a place to manage the recruiting companies / drives for a cohort, and show that list to placement students in the Campus tab (replacing the "Company drives" placeholder). Same data also surfaces as a next-up line for the placement season.

**Architecture:** New additive `PlacementDrive` Mongo model, cohort-scoped. TPO CRUD via institution routes on `org.js` (mirrors the existing `/cohorts` routes + `orgService` DI pattern). Students read a cohort-scoped list via a new `GET /api/v2/me/placement/companies` on the existing student router (which already resolves the student's cohort from enrollments). Web adds a "Companies & Drives" section to the cohort page; both apps render the Campus card from the new endpoint.

**Tech Stack:** Backend — Node/Express/Mongoose; tests use Node's built-in runner (`node:test`) + `supertest` + `router._deps` DI stubs (no DB). Web — Next.js/React/TS (`scaleup-web`, `npx next build`). iOS — Swift/SwiftUI (`ScaleUpDemo-f`). Android — React Native/TS (`ScaleUpAndroid`, `npx tsc --noEmit`).

## Global Constraints

- **Zero D2C impact.** All new routes are under institution auth (`institutionAuth` + `institutionScope`) or the placement student path (cohort-scoped via enrollment). No D2C model or route changes.
- **Scope isolation.** Every TPO query/mutation is scoped by `institutionScope(req)` (institutionId from the token, never the body). A TPO of institution A must not read/write institution B's drives. The student endpoint only returns drives for cohorts the student is enrolled in.
- **TPO write roles:** create/update/delete drives = `institution_admin`, `tpo_head`, `tpo_coordinator`. Read (list) = any authenticated institution role.
- **Run backend tests with Node's runner.** `node` is available via nvm (v20). Single-file run: `node --test <file>` (if `node` is not on PATH in a non-login shell, use `~/.nvm/versions/node/v20.20.0/bin/node --test <file>`). Full suite: `npm test`.
- **Backend deploy** = commit + push `master` (GitHub Action → box). **Web deploy** = git-less `vercel --prod` (rsync trick). **iOS** = build bump + TestFlight at the end (current build 203 → 204). **Android** = commit `main`, APK left to the team.
- **Endpoint contract (the apps + web depend on these exact shapes):**
  - TPO: `POST /api/institution/cohorts/:cohortId/drives`, `GET …/drives`, `PATCH …/drives/:driveId`, `DELETE …/drives/:driveId`.
  - Student: `GET /api/v2/me/placement/companies` → `{ success: true, data: PlacementDrive[] }`, sorted by `driveDate` ascending (null dates last) then `createdAt`.
  - `PlacementDrive` JSON: `{ _id, cohortId, name, role, package, driveDate, eligibility, status, applyLink, notes, createdAt, updatedAt }` (`institutionId` is internal; may be present but apps ignore it).

---

## File Structure

**Backend (`/Users/nirpekshnandan/My Products/ScaleUpDemo/scaleup-backend`):**
- Create `src/models/PlacementDrive.js` — the model.
- Create `src/test/institution/placementDrive.model.test.js` — model validation tests.
- Modify `src/services/institution/orgService.js` — add `createDrive`, `listDrives`, `updateDrive`, `deleteDrive`.
- Modify `src/routes/institution/org.js` — add the 4 cohort-drive routes.
- Create `src/test/institution/placementDrives.route.test.js` — route role/scope tests.
- Modify `src/routes/institution/studentAssessments.js` — add `GET /placement/companies`.
- Modify `src/test/institution/studentAssessments.route.test.js` — add a companies test (or create `placementCompanies.route.test.js`).

**Web (`/Users/nirpekshnandan/My Products/scaleup-web`):**
- Modify `lib/institutionClient.ts` — `PlacementDrive` type + `listDrives/createDrive/updateDrive/deleteDrive`.
- Modify `app/org/cohorts/[cohortId]/page.tsx` — "Companies & Drives" section.

**iOS (`/Users/nirpekshnandan/My Products/ScaleUpDemo-f`):**
- Create `ScaleUp/Features/Placements/Campus/PlacementsCampusApi.swift` — fetch companies.
- Modify `ScaleUp/Features/Placements/Campus/PlacementsCampusView.swift` — render the list.
- Modify `project.yml` — build 203 → 204.

**Android (`/Users/nirpekshnandan/My Products/ScaleUpAndroid`):**
- Create `src/features/placements/api/companiesApi.ts` — fetch companies.
- Modify the placement Campus screen (locate under `src/features/placements/screens/`, the screen behind the Campus tab in `src/features/placements/core/PlacementsMainTabs.tsx`).

---

## Task 1: Backend — PlacementDrive model

**Files:**
- Create: `src/models/PlacementDrive.js`
- Test: `src/test/institution/placementDrive.model.test.js`

**Interfaces:**
- Produces: the `PlacementDrive` mongoose model with fields `{ institutionId, cohortId, name, role, package, driveDate, eligibility, status, applyLink, notes }` + timestamps. `status` enum `['upcoming','open','closed','visited']` default `'upcoming'`. Required: `institutionId`, `cohortId`, `name`.

- [ ] **Step 1: Write the failing test.**
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const PlacementDrive = require('../../models/PlacementDrive');

test('PlacementDrive requires institutionId, cohortId, name', () => {
  const err = new PlacementDrive({}).validateSync();
  assert.ok(err.errors.institutionId, 'institutionId required');
  assert.ok(err.errors.cohortId, 'cohortId required');
  assert.ok(err.errors.name, 'name required');
});

test('PlacementDrive defaults status to upcoming and accepts the enum', () => {
  const oid = '507f1f77bcf86cd799439011';
  const d = new PlacementDrive({ institutionId: oid, cohortId: oid, name: 'Acme' });
  assert.strictEqual(d.status, 'upcoming');
  const bad = new PlacementDrive({ institutionId: oid, cohortId: oid, name: 'Acme', status: 'nope' }).validateSync();
  assert.ok(bad.errors.status, 'invalid status rejected');
});

test('PlacementDrive keeps optional fields', () => {
  const oid = '507f1f77bcf86cd799439011';
  const d = new PlacementDrive({ institutionId: oid, cohortId: oid, name: 'Acme', role: 'SDE', package: '12 LPA', eligibility: 'CGPA 7+', applyLink: 'https://x', notes: 'round 1 online' });
  assert.strictEqual(d.role, 'SDE');
  assert.strictEqual(d.package, '12 LPA');
});
```

- [ ] **Step 2: Run it to confirm it fails.**
Run: `cd "/Users/nirpekshnandan/My Products/ScaleUpDemo/scaleup-backend" && node --test src/test/institution/placementDrive.model.test.js`
Expected: FAIL — `Cannot find module '../../models/PlacementDrive'`.

- [ ] **Step 3: Implement the model.**
```js
const mongoose = require('mongoose');

const PlacementDriveSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true, index: true },
  name: { type: String, required: true, trim: true },
  role: { type: String, trim: true },
  package: { type: String, trim: true },
  driveDate: { type: Date },
  eligibility: { type: String, trim: true },
  status: { type: String, enum: ['upcoming', 'open', 'closed', 'visited'], default: 'upcoming' },
  applyLink: { type: String, trim: true },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });

PlacementDriveSchema.index({ institutionId: 1, cohortId: 1 });

module.exports = mongoose.models.PlacementDrive || mongoose.model('PlacementDrive', PlacementDriveSchema);
```

- [ ] **Step 4: Run the test to confirm it passes.**
Run: `node --test src/test/institution/placementDrive.model.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**
```
git add src/models/PlacementDrive.js src/test/institution/placementDrive.model.test.js && git commit -m "Placement drives: PlacementDrive model"
```

---

## Task 2: Backend — orgService drive methods + cohort-drive routes

**Files:**
- Modify: `src/services/institution/orgService.js`
- Modify: `src/routes/institution/org.js`
- Test: `src/test/institution/placementDrives.route.test.js`

**Interfaces:**
- Consumes: `PlacementDrive` model (Task 1); the existing `institutionAuth`, `requireInstitutionRole`, `institutionScope`, and `router._deps`/`getService` DI seam already used in `org.js`.
- Produces (orgService): `createDrive(scope, cohortId, body, deps)`, `listDrives(scope, cohortId, deps)`, `updateDrive(scope, cohortId, driveId, body, deps)`, `deleteDrive(scope, cohortId, driveId, deps)`. All scoped by `{ ...scope }` (institutionId). `createDrive`/`updateDrive` whitelist fields `{ name, role, package, driveDate, eligibility, status, applyLink, notes }`. `updateDrive`/`deleteDrive` throw `Error('DRIVE_NOT_FOUND')` when no scoped match.
- Produces (routes): `POST/GET/PATCH/DELETE /api/institution/cohorts/:cohortId/drives[/:driveId]` (write routes gated `institution_admin`,`tpo_head`,`tpo_coordinator`; GET any role).

- [ ] **Step 1: Write the failing route tests.** Mirror `src/test/institution/org.route.test.js` (its `stubLoadUser`/`tok`/`appAs` helpers — copy them). Create `src/test/institution/placementDrives.route.test.js`:
```js
'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('supertest') && require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

function stubLoadUser(institutionId, role) {
  institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId, role, status: 'active', tokenVersion: 0, scope: {} });
}
const org = require('../../routes/institution/org');
function tok(institutionId, role) { return signInstitutionToken({ _id: 'u1', institutionId, role, tokenVersion: 0 }); }
function appAs(institutionId, role) {
  stubLoadUser(institutionId, role);
  const a = express(); a.use(express.json()); a.use('/api/institution', org); return a;
}

test('viewer cannot create a drive (403)', async () => {
  const res = await request(appAs('inst-A', 'viewer'))
    .post('/api/institution/cohorts/c1/drives')
    .set('Authorization', `Bearer ${tok('inst-A', 'viewer')}`)
    .send({ name: 'Acme' });
  assert.strictEqual(res.status, 403);
  org._deps = null;
});

test('tpo_coordinator creates a drive; scope.institutionId from token, cohortId from path', async () => {
  let captured = null;
  org._deps = { orgService: { createDrive: async (scope, cohortId, body) => { captured = { scope, cohortId, body }; return { _id: 'd1', ...body }; } } };
  const res = await request(appAs('inst-A', 'tpo_coordinator'))
    .post('/api/institution/cohorts/c1/drives')
    .set('Authorization', `Bearer ${tok('inst-A', 'tpo_coordinator')}`)
    .send({ name: 'Acme', role: 'SDE', institutionId: 'inst-EVIL' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(captured.scope.institutionId, 'inst-A');
  assert.strictEqual(captured.cohortId, 'c1');
  assert.strictEqual(captured.body.name, 'Acme');
  org._deps = null;
});

test('GET drives is allowed for viewer and returns the service list', async () => {
  org._deps = { orgService: { listDrives: async () => ([{ _id: 'd1', name: 'Acme' }]) } };
  const res = await request(appAs('inst-A', 'viewer'))
    .get('/api/institution/cohorts/c1/drives')
    .set('Authorization', `Bearer ${tok('inst-A', 'viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data[0].name, 'Acme');
  org._deps = null;
});

test('PATCH unknown drive → 404', async () => {
  org._deps = { orgService: { updateDrive: async () => { throw new Error('DRIVE_NOT_FOUND'); } } };
  const res = await request(appAs('inst-A', 'tpo_head'))
    .patch('/api/institution/cohorts/c1/drives/dX')
    .set('Authorization', `Bearer ${tok('inst-A', 'tpo_head')}`)
    .send({ status: 'closed' });
  assert.strictEqual(res.status, 404);
  org._deps = null;
});
```

- [ ] **Step 2: Run to confirm failure.**
Run: `node --test src/test/institution/placementDrives.route.test.js`
Expected: FAIL (routes return 404/handler missing).

- [ ] **Step 3: Implement orgService methods.** In `src/services/institution/orgService.js`, add (using the file's existing `getModels(deps)` helper — extend it to expose `PlacementDrive` or `require` it directly):
```js
const DRIVE_FIELDS = ['name', 'role', 'package', 'driveDate', 'eligibility', 'status', 'applyLink', 'notes'];
function pickDrive(body = {}) {
  const out = {};
  for (const k of DRIVE_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  return out;
}
async function createDrive(scope, cohortId, body, deps) {
  const PlacementDrive = (deps && deps.PlacementDrive) || require('../../models/PlacementDrive');
  return PlacementDrive.create({ ...scope, cohortId, ...pickDrive(body) });
}
async function listDrives(scope, cohortId, deps) {
  const PlacementDrive = (deps && deps.PlacementDrive) || require('../../models/PlacementDrive');
  return PlacementDrive.find({ ...scope, cohortId }).sort({ driveDate: 1, createdAt: 1 }).limit(500);
}
async function updateDrive(scope, cohortId, driveId, body, deps) {
  const PlacementDrive = (deps && deps.PlacementDrive) || require('../../models/PlacementDrive');
  const d = await PlacementDrive.findOneAndUpdate({ ...scope, cohortId, _id: driveId }, { $set: pickDrive(body) }, { new: true });
  if (!d) throw new Error('DRIVE_NOT_FOUND');
  return d;
}
async function deleteDrive(scope, cohortId, driveId, deps) {
  const PlacementDrive = (deps && deps.PlacementDrive) || require('../../models/PlacementDrive');
  const d = await PlacementDrive.findOneAndDelete({ ...scope, cohortId, _id: driveId });
  if (!d) throw new Error('DRIVE_NOT_FOUND');
  return d;
}
```
Add all four to `module.exports`.

- [ ] **Step 4: Implement the routes.** In `src/routes/institution/org.js`, after the existing `/cohorts/:cohortId` routes, add (use the same `getService(router._deps)`, `institutionScope`, `requireInstitutionRole` patterns already in the file):
```js
// ── Cohort recruiting drives ─────────────────────────────────────────────────
router.post('/cohorts/:cohortId/drives', institutionAuth, requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const orgService = getService(router._deps);
    const drive = await orgService.createDrive(institutionScope(req), req.params.cohortId, req.body || {});
    return res.status(201).json({ success: true, data: drive });
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid drive data.' });
    console.error('[institution/drives:create]', err.message);
    return res.status(500).json({ success: false, message: 'Could not create drive.' });
  }
});
router.get('/cohorts/:cohortId/drives', institutionAuth, async (req, res) => {
  try {
    const orgService = getService(router._deps);
    const drives = await orgService.listDrives(institutionScope(req), req.params.cohortId);
    return res.status(200).json({ success: true, data: drives });
  } catch (err) {
    console.error('[institution/drives:list]', err.message);
    return res.status(500).json({ success: false, message: 'Could not list drives.' });
  }
});
router.patch('/cohorts/:cohortId/drives/:driveId', institutionAuth, requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const orgService = getService(router._deps);
    const drive = await orgService.updateDrive(institutionScope(req), req.params.cohortId, req.params.driveId, req.body || {});
    return res.status(200).json({ success: true, data: drive });
  } catch (err) {
    if (err.message === 'DRIVE_NOT_FOUND') return res.status(404).json({ success: false, message: 'Drive not found.' });
    if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid drive data.' });
    console.error('[institution/drives:update]', err.message);
    return res.status(500).json({ success: false, message: 'Could not update drive.' });
  }
});
router.delete('/cohorts/:cohortId/drives/:driveId', institutionAuth, requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const orgService = getService(router._deps);
    await orgService.deleteDrive(institutionScope(req), req.params.cohortId, req.params.driveId);
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err.message === 'DRIVE_NOT_FOUND') return res.status(404).json({ success: false, message: 'Drive not found.' });
    console.error('[institution/drives:delete]', err.message);
    return res.status(500).json({ success: false, message: 'Could not delete drive.' });
  }
});
```
(If `requireInstitutionRole`/`institutionScope`/`getService` are not already imported at the top of `org.js`, they are — confirm by reading the file; the existing `/cohorts` routes use them.)

- [ ] **Step 5: Run the tests to confirm they pass.**
Run: `node --test src/test/institution/placementDrives.route.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit.**
```
git add src/services/institution/orgService.js src/routes/institution/org.js src/test/institution/placementDrives.route.test.js && git commit -m "Placement drives: TPO CRUD routes + orgService methods (scoped, role-gated)"
```

---

## Task 3: Backend — student companies endpoint

**Files:**
- Modify: `src/routes/institution/studentAssessments.js`
- Test: `src/test/institution/placementCompanies.route.test.js`

**Interfaces:**
- Consumes: the student router's existing auth (`getAuth()` → `req.user.userId`) and enrollment resolution (`getEnrollment()` → `Enrollment.find({ userId })` → `cohortIds`). Add a DI getter `getPlacementDrive()` mirroring the existing `getEnrollment()`/`getAssessment()` getters (returns `router._deps.PlacementDrive || require('../../models/PlacementDrive')`).
- Produces: `GET /api/v2/me/placement/companies` → `{ success: true, data: PlacementDrive[] }` for the student's enrolled cohorts, sorted `driveDate` asc then `createdAt`. Empty array if no enrollment.

- [ ] **Step 1: Write the failing test.** Mirror `src/test/institution/studentAssessments.route.test.js` for the DI/auth stub style (read it for the exact `auth` stub + app mount). Create `src/test/institution/placementCompanies.route.test.js`:
```js
'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const router = require('../../routes/institution/studentAssessments');

function appWith(deps) {
  router._deps = deps;
  const a = express(); a.use(express.json());
  a.use('/api/v2/me', router);
  return a;
}
const authStub = (userId) => (req, _res, next) => { req.user = { userId }; next(); };

test('companies: returns drives for the student cohorts', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([{ cohortId: 'c1' }, { cohortId: 'c2' }]) }) },
    PlacementDrive: { find: (q) => { assert.deepStrictEqual(q.cohortId.$in, ['c1', 'c2']); return { sort: () => ({ lean: async () => ([{ _id: 'd1', name: 'Acme' }]) }) }; } },
  });
  const res = await request(app).get('/api/v2/me/placement/companies');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data[0].name, 'Acme');
  router._deps = null;
});

test('companies: empty when no enrollment', async () => {
  const app = appWith({ auth: authStub('stu1'), InstitutionEnrollment: { find: () => ({ lean: async () => ([]) }) } });
  const res = await request(app).get('/api/v2/me/placement/companies');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.data, []);
  router._deps = null;
});
```
(Confirm the enrollment stub shape matches how the file calls it — it uses `Enrollment.find({ userId })` then `.lean()` when present; the existing assessments test shows the exact stub shape — copy it.)

- [ ] **Step 2: Run to confirm failure.**
Run: `node --test src/test/institution/placementCompanies.route.test.js`
Expected: FAIL (route 404).

- [ ] **Step 3: Implement the route.** In `src/routes/institution/studentAssessments.js`, add the DI getter near the others:
```js
function getPlacementDrive() {
  return (router._deps && router._deps.PlacementDrive) || require('../../models/PlacementDrive');
}
```
and add the route (before `module.exports`):
```js
// GET /placement/companies — recruiting drives for the student's cohort(s).
router.get('/placement/companies', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const Enrollment = getEnrollment();
    const PlacementDrive = getPlacementDrive();
    const enrollmentsQuery = Enrollment.find({ userId });
    const enrollments = typeof enrollmentsQuery.lean === 'function' ? await enrollmentsQuery.lean() : await enrollmentsQuery;
    const cohortIds = enrollments.map((e) => e.cohortId);
    if (!cohortIds.length) return res.status(200).json({ success: true, data: [] });
    const drivesQuery = PlacementDrive.find({ cohortId: { $in: cohortIds } }).sort({ driveDate: 1, createdAt: 1 });
    const drives = typeof drivesQuery.lean === 'function' ? await drivesQuery.lean() : await drivesQuery;
    return res.status(200).json({ success: true, data: drives });
  } catch (err) {
    console.error('[studentAssessments:companies]', err.message);
    return res.status(500).json({ success: false, message: 'Could not list companies.' });
  }
});
```

- [ ] **Step 4: Run the test to confirm it passes.**
Run: `node --test src/test/institution/placementCompanies.route.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full institution suite to confirm no regressions, then commit.**
Run: `node --test src/test/institution/*.test.js`
Expected: all pass.
```
git add src/routes/institution/studentAssessments.js src/test/institution/placementCompanies.route.test.js && git commit -m "Placement drives: GET /me/placement/companies (cohort-scoped student list)"
```
Then push so the backend deploys before the apps/web rely on it:
```
git push origin master
```

---

## Task 4: Web — Companies & Drives section on the cohort page

**Files:**
- Modify: `lib/institutionClient.ts`
- Modify: `app/org/cohorts/[cohortId]/page.tsx`

**Interfaces:**
- Consumes: the TPO routes from Task 2. Add to `institutionApi`: `listDrives(cohortId)`, `createDrive(cohortId, body)`, `updateDrive(cohortId, driveId, body)`, `deleteDrive(cohortId, driveId)` using the existing `req(...)` helper (it supports any method).
- Produces: a "Companies & Drives" section after the existing "Placement season" section, visible to all roles; add/edit/delete gated to `canManageObjective` (already computed on the page = admin/tpo_head). Reuse `canManageObjective` or add `canManageDrives = role==='tpo_head' || role==='institution_admin' || role==='tpo_coordinator'`.

- [ ] **Step 1: Add the type + client methods.** In `lib/institutionClient.ts`:
```ts
export interface PlacementDrive {
  _id: string; cohortId: string; name: string; role?: string; package?: string;
  driveDate?: string; eligibility?: string;
  status: 'upcoming' | 'open' | 'closed' | 'visited';
  applyLink?: string; notes?: string; createdAt?: string;
}
```
and in the `institutionApi` object:
```ts
  listDrives: (cohortId: string) =>
    req<{ success: boolean; data: PlacementDrive[] }>('GET', `/cohorts/${encodeURIComponent(cohortId)}/drives`),
  createDrive: (cohortId: string, b: Partial<PlacementDrive>) =>
    req<{ success: boolean; data: PlacementDrive }>('POST', `/cohorts/${encodeURIComponent(cohortId)}/drives`, b),
  updateDrive: (cohortId: string, driveId: string, b: Partial<PlacementDrive>) =>
    req<{ success: boolean; data: PlacementDrive }>('PATCH', `/cohorts/${encodeURIComponent(cohortId)}/drives/${encodeURIComponent(driveId)}`, b),
  deleteDrive: (cohortId: string, driveId: string) =>
    req<{ success: boolean }>('DELETE', `/cohorts/${encodeURIComponent(cohortId)}/drives/${encodeURIComponent(driveId)}`),
```

- [ ] **Step 2: Add the section UI.** In `app/org/cohorts/[cohortId]/page.tsx`, after the "Placement season" `<Card>`, add a "Companies & Drives" `<SectionLabel>` + `<Card>` that: loads drives on mount (add `drives` state + `loadDrives()` calling `institutionApi.listDrives(cohortId)` in the existing `useEffect`), renders each drive (name, role, package, date, a status chip, apply link), and — when the user can manage — an inline add form (name required + role/package/driveDate/eligibility/status/applyLink/notes) wired to `createDrive`, an edit affordance wired to `updateDrive` (status dropdown at minimum), and a delete wired to `deleteDrive`. Follow the visual patterns already in the file (`Card`, `Field`, `Btn`, `Chip`, `inputCls`, `inputStyle`, `ORG` colors). Use a `<select>` for status with the four enum values. Refresh the list after each mutation. Keep it consistent with the "Placement season" editor's add/save/error affordances.

- [ ] **Step 3: Build-verify.**
Run: `cd "/Users/nirpekshnandan/My Products/scaleup-web" && npx next build 2>&1 | grep -iE "error|Compiled successfully" | head`
Expected: "Compiled successfully", no errors.

- [ ] **Step 4: Deploy + commit.**
```
SRC="/Users/nirpekshnandan/My Products/scaleup-web"; rm -rf /tmp/sw-deploy && rsync -a --exclude=.git --exclude=node_modules --exclude=.next "$SRC/" /tmp/sw-deploy/ && cd /tmp/sw-deploy && npx vercel --prod --yes 2>&1 | grep -iE "Production|Aliased" | head
cd "$SRC" && git add lib/institutionClient.ts "app/org/cohorts/[cohortId]/page.tsx" && git commit -m "Placement drives: TPO Companies & Drives editor on cohort page"
```

---

## Task 5: iOS — Campus "Company drives" card

**Files:**
- Create: `ScaleUp/Features/Placements/Campus/PlacementsCampusApi.swift`
- Modify: `ScaleUp/Features/Placements/Campus/PlacementsCampusView.swift`
- Modify: `project.yml` (build 203 → 204)

**Interfaces:**
- Consumes: `GET /me/placement/companies`. Read an existing placement API client (e.g. `PlacementsAssessmentsApi.swift`) for the exact `V2APIClient` + `V2APIResponse` usage and copy that style.

- [ ] **Step 1: Create the API + models.** In `PlacementsCampusApi.swift`, add `Codable` `PlacementDrive { let id: String (from "_id"); let name: String; let role: String?; let package: String?; let driveDate: String?; let eligibility: String?; let status: String; let applyLink: String?; let notes: String? }` (Identifiable via `id`) and an API method `func fetchCompanies() async throws -> [PlacementDrive]` calling `GET /me/placement/companies` (mirror the existing placement API client's unwrap of `V2APIResponse<[…]>`).

- [ ] **Step 2: Render the list.** In `PlacementsCampusView.swift`, replace the "Company drives" placeholder card with a real section: on `.task`, fetch companies; show a row per drive (name, role/package subtitle, date, a status pill); empty state keeps a short "No drives yet — your TPO will add recruiters here." Keep the "TPO notices" placeholder card untouched (that's Phase 3). Use the existing theme tokens used elsewhere in the file. Tapping a drive with an `applyLink` opens it (Link/openURL); otherwise no-op.

- [ ] **Step 3: Bump build.** In `project.yml`, set `CURRENT_PROJECT_VERSION: 204`.

- [ ] **Step 4: Compile-verify.**
Run:
```
cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && /opt/homebrew/bin/xcodegen generate && xcodebuild -scheme ScaleUp -destination 'generic/platform=iOS' -configuration Debug build CODE_SIGNING_ALLOWED=NO -quiet 2>&1 | tail -25
```
Expected: BUILD SUCCEEDED.

- [ ] **Step 5: Commit.**
```
cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && git add -A && git commit -m "Placement drives: Campus company-drives list from /me/placement/companies; build 204"
```

---

## Task 6: Android — Campus "Company drives" card

**Files:**
- Create: `src/features/placements/api/companiesApi.ts`
- Modify: the placement Campus screen (locate it from `src/features/placements/core/PlacementsMainTabs.tsx` — the screen behind the "Campus" tab, likely `src/features/placements/screens/PlacementsCampusScreen.tsx`).

**Interfaces:**
- Consumes: `GET /me/placement/companies`. Mirror an existing placement api (e.g. `src/features/placements/api/assessmentsApi.ts`) for the `V2Api.get<T>(path)` style.

- [ ] **Step 1: Create the api + types.** In `companiesApi.ts`, add `export type PlacementDrive = { _id: string; name: string; role?: string; package?: string; driveDate?: string; eligibility?: string; status: 'upcoming'|'open'|'closed'|'visited'; applyLink?: string; notes?: string }` and `export async function fetchCompanies(): Promise<PlacementDrive[]>` calling `/me/placement/companies` (mirror `assessmentsApi.ts` unwrap).

- [ ] **Step 2: Render the list.** In the placement Campus screen, replace the "Company drives" placeholder with a real list (fetch on focus/mount): a row per drive (name, role/package, date, status chip); short empty state; tapping a drive with `applyLink` opens it via `Linking.openURL`. Leave the "TPO notices" placeholder (Phase 3). Use the screen's existing styling tokens.

- [ ] **Step 3: Type-check.**
Run: `cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && npx tsc --noEmit 2>&1 | tail -25`
Expected: exit 0, no new errors.

- [ ] **Step 4: Commit.**
```
cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && git add -A && git commit -m "Placement drives: Campus company-drives list from /me/placement/companies"
```

---

## Final steps (after all 6 tasks)

- [ ] Backend already pushed in Task 3 — confirm the box is on the new commit and pm2 is online (EC2 Instance Connect → `git log --oneline -1` + `pm2 jlist`).
- [ ] iOS: archive + upload **build 204** to TestFlight (the established pipeline + inline auth flags).
- [ ] Android: leave for the team's APK build.
- [ ] Report: the TPO can now add companies/drives on the cohort page; placement students see them in Campus. Note Phase 3 (Notices) and Phase 4 (Shelves) remain.

## Self-Review notes (addressed)

- **Spec coverage:** Module 4 (Companies & Drives) of the design spec is fully covered: model (T1), TPO CRUD scoped+role-gated (T2), student endpoint (T3), TPO web editor (T4), Campus card on both apps (T5,T6). The optional placement-season "next-up" line is folded into the Campus card surface rather than the Home season card to keep Phase 2 from touching Home plumbing — noted as a deliberate scope trim.
- **Scope isolation tested:** T2 asserts institutionId comes from the token (not body) and unknown drive → 404; the model is required-scoped. T3 asserts cohort-from-enrollment and empty-without-enrollment.
- **Type consistency:** the `PlacementDrive` JSON shape is identical across backend model, web type, and both app models (`_id`/`id`, `status` enum, optional fields).
- **No placeholders:** every code step contains complete code or precise, file-anchored instructions; UI-assembly steps (T4/T5/T6 rendering) point at the exact existing patterns to copy since pixel-exact UI is not load-bearing and the implementer reads the file's tokens.
