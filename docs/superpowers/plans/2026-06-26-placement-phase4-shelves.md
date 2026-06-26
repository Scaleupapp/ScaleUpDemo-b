# Placement Phase 4 — Curated Shelves + Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the TPO build cohort-scoped "shelves" of prep material (e.g. Aptitude / DSA / HR Prep), each holding **link** items (Drive/YouTube/article URLs) and **file** items (uploaded PDFs etc.), and show them to placement students in the Library tab — replacing the "Curated shelves coming soon" placeholder.

**Architecture:** Two additive Mongo models — `Shelf` (cohort-scoped, ordered) and `ShelfItem` (belongs to a shelf; `type: link|file`). TPO CRUD via a new `src/routes/institution/shelves.js`; item writes verify the parent shelf is in scope before mutating. File items reuse the Phase-3 `POST /uploads/sign` presign primitive (TPO uploads to S3, stores `s3Key`); students read file items as short-lived presigned GET URLs (`generateDownloadURL`). Students read via a new route on the existing student router (`/api/v2/me`).

**Tech Stack:** Backend — Node/Express/Mongoose; tests `node:test` + `supertest` + `router._deps` DI stubs (no DB/AWS). Web — Next.js/React/TS (`scaleup-web`). iOS — Swift/SwiftUI (`ScaleUpDemo-f`). Android — React Native/TS (`ScaleUpAndroid`).

## Global Constraints

- **Zero D2C impact.** Additive models + routes. TPO routes behind `institutionAuth` + `institutionScope`; student routes cohort-scoped via enrollment. No D2C changes.
- **Scope isolation.** TPO shelf queries/mutations scoped by `institutionScope(req)` (institutionId from token, never body). Item mutations must first verify the parent shelf is in scope (no editing items under another institution's shelf). Students see only their enrolled cohort(s)' shelves.
- **Roles:** create/update/delete shelves + items = `institution_admin`, `tpo_head`, `tpo_coordinator`. List (TPO) = any institution role.
- **Field whitelist on writes** (no mass-assigning `institutionId`/`cohortId`/`shelfId`/`_id`/`createdBy`).
- **Reuse the Phase-3 upload primitive:** the web uses the existing `POST /api/institution/uploads/sign` + `uploadFile` helper for file items; students get presigned GET URLs via `src/config/s3.js` `generateDownloadURL`. No new S3 code.
- **Tests:** `node --test <file>` (node v20 via nvm; if not on PATH use `~/.nvm/versions/node/v20.20.0/bin/node --test <file>`).
- **Deploy:** backend = push `master`; web = git-less `vercel --prod`; iOS = build bump 205 → 206 + TestFlight; Android = commit `main`.
- **Endpoint contract:**
  - TPO shelves: `POST/GET /api/institution/cohorts/:cohortId/shelves`, `PATCH/DELETE …/shelves/:shelfId`; items `POST …/shelves/:shelfId/items`, `PATCH/DELETE …/shelves/:shelfId/items/:itemId`. GET → `{ success, data: ShelfWithItems[] }` (shelves ordered by `order` asc, each with its `items` ordered by `order`).
  - Student: `GET /api/v2/me/placement/shelves` → `{ success, data: StudentShelf[] }` ordered by `order`; each item is `{ _id, type, title, note, url }` where for `type:'link'` `url` is the stored URL and for `type:'file'` `url` is a presigned GET URL (+ `fileName`, `mime`); raw `s3Key` is never returned.
  - `Shelf` JSON `{ _id, cohortId, title, order, createdAt }`; `ShelfItem` JSON `{ _id, shelfId, type, title, url?, s3Key?, fileName?, mime?, note?, order }` (TPO sees `s3Key`; student sees presigned `url`).

---

## File Structure

**Backend:** `src/models/Shelf.js`, `src/models/ShelfItem.js`; `src/services/institution/shelfService.js`; `src/routes/institution/shelves.js`; mount in `src/routes/institution/index.js`; student route in `src/routes/institution/studentAssessments.js`. Tests: `shelf.model.test.js`, `shelves.route.test.js`, `placementShelves.route.test.js`.

**Web:** `lib/institutionClient.ts` (types + methods; reuse existing `signUpload`/`uploadFile` from Phase 3) + `app/org/cohorts/[cohortId]/page.tsx` ("Curated shelves" section).

**iOS:** `ScaleUp/Features/Placements/Library/PlacementsLibraryApi.swift` (new) + `PlacementsLibraryView.swift` (replace placeholder) + `project.yml` build 206.

**Android:** `src/features/placements/api/shelvesApi.ts` (new) + the Library tab screen (from `src/features/placements/core/PlacementsMainTabs.tsx`, likely `src/features/placements/screens/PlacementsLibraryScreen.tsx`).

---

## Task 1: Backend — Shelf + ShelfItem models

**Files:** Create `src/models/Shelf.js`, `src/models/ShelfItem.js`; Test `src/test/institution/shelf.model.test.js`.

**Interfaces:** `Shelf` (required `institutionId`,`cohortId`,`title`; `order` Number default 0; `createdBy`; timestamps). `ShelfItem` (required `shelfId`,`type` enum `['link','file']`,`title`; optional `url`,`s3Key`,`fileName`,`mime`,`note`; `order` default 0; `createdBy`; timestamps).

- [ ] **Step 1: Write the failing test.**
```js
'use strict';
const test = require('node:test'); const assert = require('node:assert');
const Shelf = require('../../models/Shelf');
const ShelfItem = require('../../models/ShelfItem');
const oid = '507f1f77bcf86cd799439011';

test('Shelf requires institutionId, cohortId, title; order defaults 0', () => {
  const err = new Shelf({}).validateSync();
  assert.ok(err.errors.institutionId && err.errors.cohortId && err.errors.title);
  const s = new Shelf({ institutionId: oid, cohortId: oid, title: 'DSA' });
  assert.strictEqual(s.order, 0);
});
test('ShelfItem requires shelfId, type, title and validates the type enum', () => {
  const err = new ShelfItem({}).validateSync();
  assert.ok(err.errors.shelfId && err.errors.type && err.errors.title);
  const bad = new ShelfItem({ shelfId: oid, type: 'video', title: 'x' }).validateSync();
  assert.ok(bad.errors.type);
  const link = new ShelfItem({ shelfId: oid, type: 'link', title: 'GFG', url: 'https://x', note: 'read this' });
  assert.strictEqual(link.url, 'https://x');
});
```

- [ ] **Step 2: Run to confirm failure.** `node --test src/test/institution/shelf.model.test.js` → FAIL.

- [ ] **Step 3: Implement the models.**
`src/models/Shelf.js`:
```js
const mongoose = require('mongoose');
const ShelfSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true, index: true },
  title: { type: String, required: true, trim: true },
  order: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });
ShelfSchema.index({ institutionId: 1, cohortId: 1, order: 1 });
module.exports = mongoose.models.Shelf || mongoose.model('Shelf', ShelfSchema);
```
`src/models/ShelfItem.js`:
```js
const mongoose = require('mongoose');
const ShelfItemSchema = new mongoose.Schema({
  shelfId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shelf', required: true, index: true },
  type: { type: String, enum: ['link', 'file'], required: true },
  title: { type: String, required: true, trim: true },
  url: { type: String, trim: true },        // type=link
  s3Key: { type: String },                  // type=file
  fileName: { type: String, trim: true },
  mime: { type: String, trim: true },
  note: { type: String, trim: true },
  order: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });
ShelfItemSchema.index({ shelfId: 1, order: 1 });
module.exports = mongoose.models.ShelfItem || mongoose.model('ShelfItem', ShelfItemSchema);
```

- [ ] **Step 4: Run to confirm pass.** `node --test src/test/institution/shelf.model.test.js` → PASS (2).

- [ ] **Step 5: Commit.** `git add src/models/Shelf.js src/models/ShelfItem.js src/test/institution/shelf.model.test.js && git commit -m "Placement shelves: Shelf + ShelfItem models"`

---

## Task 2: Backend — shelfService + TPO shelves/items routes

**Files:** Create `src/services/institution/shelfService.js`, `src/routes/institution/shelves.js`; Modify `src/routes/institution/index.js`; Test `src/test/institution/shelves.route.test.js`.

**Interfaces:**
- Produces (service): `createShelf(scope, cohortId, body, deps)`, `listShelves(scope, cohortId, deps)` (→ array of shelves, each with `items` ordered by `order`), `updateShelf(scope, cohortId, shelfId, body, deps)` (404 `SHELF_NOT_FOUND`), `deleteShelf(scope, cohortId, shelfId, deps)` (404; also deletes the shelf's items), `addItem(scope, cohortId, shelfId, body, deps)` / `updateItem(scope, cohortId, shelfId, itemId, body, deps)` / `deleteItem(scope, cohortId, shelfId, itemId, deps)` — each FIRST verifies the parent shelf is in `{ ...scope, cohortId, _id: shelfId }` (throws `SHELF_NOT_FOUND` if not), then operates on the item by `{ shelfId, _id }`. Whitelists: shelf `{ title, order }`; item `{ type, title, url, s3Key, fileName, mime, note, order }`.
- Produces (routes): the 7 endpoints in the contract.

- [ ] **Step 1: Write the failing route tests.** `src/test/institution/shelves.route.test.js` (copy `org.route.test.js` helpers; mount `require('../../routes/institution/shelves')` as `shelves`):
```js
test('viewer cannot create a shelf (403)', async () => {
  const res = await request(appAs('inst-A','viewer')).post('/api/institution/cohorts/c1/shelves')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`).send({ title: 'DSA' });
  assert.strictEqual(res.status, 403); shelves._deps = null;
});
test('tpo_head creates shelf; scope from token, cohort from path', async () => {
  let cap = null;
  shelves._deps = { shelfService: { createShelf: async (scope, cohortId, body) => { cap = { scope, cohortId, body }; return { _id: 's1', ...body }; } } };
  const res = await request(appAs('inst-A','tpo_head')).post('/api/institution/cohorts/c1/shelves')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`).send({ title: 'DSA', institutionId: 'EVIL' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(cap.scope.institutionId, 'inst-A'); assert.strictEqual(cap.cohortId, 'c1'); assert.strictEqual(cap.body.title, 'DSA');
  shelves._deps = null;
});
test('GET shelves any role', async () => {
  shelves._deps = { shelfService: { listShelves: async () => ([{ _id: 's1', title: 'DSA', items: [] }]) } };
  const res = await request(appAs('inst-A','viewer')).get('/api/institution/cohorts/c1/shelves')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`);
  assert.strictEqual(res.status, 200); assert.strictEqual(res.body.data[0].title, 'DSA'); shelves._deps = null;
});
test('add item to unknown shelf → 404', async () => {
  shelves._deps = { shelfService: { addItem: async () => { throw new Error('SHELF_NOT_FOUND'); } } };
  const res = await request(appAs('inst-A','tpo_coordinator')).post('/api/institution/cohorts/c1/shelves/sX/items')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_coordinator')}`).send({ type: 'link', title: 'x', url: 'https://y' });
  assert.strictEqual(res.status, 404); shelves._deps = null;
});
test('DELETE item ok', async () => {
  let called = null;
  shelves._deps = { shelfService: { deleteItem: async (scope, cohortId, shelfId, itemId) => { called = { scope, cohortId, shelfId, itemId }; return { _id: itemId }; } } };
  const res = await request(appAs('inst-A','tpo_head')).delete('/api/institution/cohorts/c1/shelves/s1/items/i1')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`);
  assert.strictEqual(res.status, 200); assert.strictEqual(called.shelfId, 's1'); assert.strictEqual(called.itemId, 'i1'); shelves._deps = null;
});
```

- [ ] **Step 2: Run to confirm failure.** `node --test src/test/institution/shelves.route.test.js` → FAIL.

- [ ] **Step 3: Implement the service.** `src/services/institution/shelfService.js`:
```js
'use strict';
const SHELF_FIELDS = ['title', 'order'];
const ITEM_FIELDS = ['type', 'title', 'url', 's3Key', 'fileName', 'mime', 'note', 'order'];
function pick(fields, body = {}) { const o = {}; for (const k of fields) if (body[k] !== undefined) o[k] = body[k]; return o; }
function models(deps) {
  return {
    Shelf: (deps && deps.Shelf) || require('../../models/Shelf'),
    ShelfItem: (deps && deps.ShelfItem) || require('../../models/ShelfItem'),
  };
}
async function createShelf(scope, cohortId, body, deps) {
  const { Shelf } = models(deps);
  return Shelf.create({ ...scope, cohortId, ...pick(SHELF_FIELDS, body) });
}
async function listShelves(scope, cohortId, deps) {
  const { Shelf, ShelfItem } = models(deps);
  const sq = Shelf.find({ ...scope, cohortId }).sort({ order: 1, createdAt: 1 }).limit(200);
  const shelves = typeof sq.lean === 'function' ? await sq.lean() : await sq;
  const ids = shelves.map((s) => s._id);
  const iq = ShelfItem.find({ shelfId: { $in: ids } }).sort({ order: 1, createdAt: 1 });
  const items = typeof iq.lean === 'function' ? await iq.lean() : await iq;
  const byShelf = {}; for (const it of items) { (byShelf[String(it.shelfId)] ||= []).push(it); }
  return shelves.map((s) => ({ ...s, items: byShelf[String(s._id)] || [] }));
}
async function updateShelf(scope, cohortId, shelfId, body, deps) {
  const { Shelf } = models(deps);
  const s = await Shelf.findOneAndUpdate({ ...scope, cohortId, _id: shelfId }, { $set: pick(SHELF_FIELDS, body) }, { new: true });
  if (!s) throw new Error('SHELF_NOT_FOUND'); return s;
}
async function deleteShelf(scope, cohortId, shelfId, deps) {
  const { Shelf, ShelfItem } = models(deps);
  const s = await Shelf.findOneAndDelete({ ...scope, cohortId, _id: shelfId });
  if (!s) throw new Error('SHELF_NOT_FOUND');
  try { await ShelfItem.deleteMany({ shelfId }); } catch (e) { /* best-effort */ }
  return s;
}
async function assertShelf(scope, cohortId, shelfId, deps) {
  const { Shelf } = models(deps);
  const s = await Shelf.findOne({ ...scope, cohortId, _id: shelfId });
  if (!s) throw new Error('SHELF_NOT_FOUND');
  return s;
}
async function addItem(scope, cohortId, shelfId, body, deps) {
  const { ShelfItem } = models(deps);
  await assertShelf(scope, cohortId, shelfId, deps);
  return ShelfItem.create({ shelfId, ...pick(ITEM_FIELDS, body) });
}
async function updateItem(scope, cohortId, shelfId, itemId, body, deps) {
  const { ShelfItem } = models(deps);
  await assertShelf(scope, cohortId, shelfId, deps);
  const it = await ShelfItem.findOneAndUpdate({ shelfId, _id: itemId }, { $set: pick(ITEM_FIELDS, body) }, { new: true });
  if (!it) throw new Error('ITEM_NOT_FOUND'); return it;
}
async function deleteItem(scope, cohortId, shelfId, itemId, deps) {
  const { ShelfItem } = models(deps);
  await assertShelf(scope, cohortId, shelfId, deps);
  const it = await ShelfItem.findOneAndDelete({ shelfId, _id: itemId });
  if (!it) throw new Error('ITEM_NOT_FOUND'); return it;
}
module.exports = { createShelf, listShelves, updateShelf, deleteShelf, addItem, updateItem, deleteItem };
```

- [ ] **Step 4: Implement the routes.** `src/routes/institution/shelves.js` — mirror `notices.js` (DI `router._deps`, `getService`, `institutionAuth`, `WRITE = requireInstitutionRole('institution_admin','tpo_head','tpo_coordinator')`, `institutionScope`). Map `SHELF_NOT_FOUND`/`ITEM_NOT_FOUND` → 404, ValidationError/CastError → 400. Endpoints:
  - `POST /cohorts/:cohortId/shelves` (WRITE) → 201 createShelf
  - `GET /cohorts/:cohortId/shelves` (any) → 200 listShelves
  - `PATCH /cohorts/:cohortId/shelves/:shelfId` (WRITE) → 200 updateShelf
  - `DELETE /cohorts/:cohortId/shelves/:shelfId` (WRITE) → 200 deleteShelf
  - `POST /cohorts/:cohortId/shelves/:shelfId/items` (WRITE) → 201 addItem
  - `PATCH /cohorts/:cohortId/shelves/:shelfId/items/:itemId` (WRITE) → 200 updateItem
  - `DELETE /cohorts/:cohortId/shelves/:shelfId/items/:itemId` (WRITE) → 200 deleteItem
  Each handler calls `getService(router._deps).<method>(institutionScope(req), req.params.cohortId, …)`. Then mount in `src/routes/institution/index.js`: `router.use('/', require('./shelves'));`.

- [ ] **Step 5: Run to confirm pass.** `node --test src/test/institution/shelves.route.test.js` → PASS (5).

- [ ] **Step 6: Commit.** `git add src/services/institution/shelfService.js src/routes/institution/shelves.js src/routes/institution/index.js src/test/institution/shelves.route.test.js && git commit -m "Placement shelves: TPO shelves + items CRUD (scoped, role-gated, parent-shelf check)"`

---

## Task 3: Backend — student shelves endpoint

**Files:** Modify `src/routes/institution/studentAssessments.js`; Test `src/test/institution/placementShelves.route.test.js`.

**Interfaces:** Add DI getters `getShelf()`/`getShelfItem()` (mirror `getNotice()`); reuse `getGenDownload()` (added in Phase 3). `GET /placement/shelves` → cohort+institution-scoped shelves ordered by `order`, each with `items` ordered by `order`; link items → `{ _id, type:'link', title, note, url }`; file items → `{ _id, type:'file', title, note, fileName, mime, url: <presigned GET> }` (no `s3Key`).

- [ ] **Step 1: Write the failing test.** `src/test/institution/placementShelves.route.test.js` (mirror `placementNotices.route.test.js` DI mount):
```js
'use strict';
const test = require('node:test'); const assert = require('node:assert');
const express = require('express'); const request = require('supertest');
const router = require('../../routes/institution/studentAssessments');
function appWith(deps) { router._deps = deps; const a = express(); a.use(express.json()); a.use('/api/v2/me', router); return a; }
const authStub = (userId) => (req, _res, next) => { req.user = { userId }; next(); };

test('shelves: cohort+institution scoped, items with presigned file url, no s3Key', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([{ cohortId: 'c1', institutionId: 'inst-A' }]) }) },
    Shelf: { find: (q) => { assert.deepStrictEqual(q.institutionId.$in, ['inst-A']); assert.deepStrictEqual(q.cohortId.$in, ['c1']); return { sort: () => ({ lean: async () => ([{ _id: 's1', title: 'DSA', order: 0 }]) }) }; } },
    ShelfItem: { find: () => ({ sort: () => ({ lean: async () => ([
      { _id: 'i1', shelfId: 's1', type: 'link', title: 'GFG', url: 'https://g', note: 'n', order: 0 },
      { _id: 'i2', shelfId: 's1', type: 'file', title: 'PDF', s3Key: 'k', fileName: 'a.pdf', mime: 'application/pdf', order: 1 },
    ]) }) }) },
    generateDownloadURL: async (key) => `https://signed/${key}`,
  });
  const res = await request(app).get('/api/v2/me/placement/shelves');
  assert.strictEqual(res.status, 200);
  const shelf = res.body.data[0];
  assert.strictEqual(shelf.items[0].url, 'https://g');
  assert.strictEqual(shelf.items[1].url, 'https://signed/k');
  assert.strictEqual(shelf.items[1].s3Key, undefined);
  router._deps = null;
});
test('shelves: empty when no enrollment', async () => {
  const app = appWith({ auth: authStub('stu1'), InstitutionEnrollment: { find: () => ({ lean: async () => ([]) }) } });
  const res = await request(app).get('/api/v2/me/placement/shelves');
  assert.deepStrictEqual(res.body.data, []);
  router._deps = null;
});
```

- [ ] **Step 2: Run to confirm failure.** `node --test src/test/institution/placementShelves.route.test.js` → FAIL.

- [ ] **Step 3: Implement.** In `studentAssessments.js`, add getters:
```js
function getShelf() { return (router._deps && router._deps.Shelf) || require('../../models/Shelf'); }
function getShelfItem() { return (router._deps && router._deps.ShelfItem) || require('../../models/ShelfItem'); }
```
and the route (before `module.exports`):
```js
// GET /placement/shelves — curated shelves for the student's cohort(s).
router.get('/placement/shelves', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const Enrollment = getEnrollment();
    const enq = Enrollment.find({ userId });
    const enrollments = typeof enq.lean === 'function' ? await enq.lean() : await enq;
    const cohortIds = enrollments.map((e) => e.cohortId);
    const institutionIds = [...new Set(enrollments.map((e) => e.institutionId).filter(Boolean))];
    if (!cohortIds.length) return res.status(200).json({ success: true, data: [] });
    const Shelf = getShelf();
    const sq = Shelf.find({ institutionId: { $in: institutionIds }, cohortId: { $in: cohortIds } }).sort({ order: 1, createdAt: 1 });
    const shelves = typeof sq.lean === 'function' ? await sq.lean() : await sq;
    if (!shelves.length) return res.status(200).json({ success: true, data: [] });
    const ShelfItem = getShelfItem();
    const iq = ShelfItem.find({ shelfId: { $in: shelves.map((s) => s._id) } }).sort({ order: 1, createdAt: 1 });
    const items = typeof iq.lean === 'function' ? await iq.lean() : await iq;
    const genDownload = getGenDownload();
    const byShelf = {};
    for (const it of items) {
      let url = it.url || null;
      if (it.type === 'file' && it.s3Key) { try { url = await genDownload(it.s3Key); } catch (e) { url = null; } }
      (byShelf[String(it.shelfId)] ||= []).push({ _id: it._id, type: it.type, title: it.title, note: it.note || null, fileName: it.fileName || null, mime: it.mime || null, url });
    }
    const data = shelves.map((s) => ({ _id: s._id, title: s.title, order: s.order, items: byShelf[String(s._id)] || [] }));
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[studentAssessments:shelves]', err.message);
    return res.status(500).json({ success: false, message: 'Could not list shelves.' });
  }
});
```

- [ ] **Step 4: Run to confirm pass.** `node --test src/test/institution/placementShelves.route.test.js` → PASS (2).

- [ ] **Step 5: Full suite + commit + push.**
`node --test src/test/institution/*.test.js` → green.
```
git add src/routes/institution/studentAssessments.js src/test/institution/placementShelves.route.test.js && git commit -m "Placement shelves: GET /me/placement/shelves (cohort-scoped, presigned file urls)"
git push origin master
```

---

## Task 4: Web — Curated shelves manager

**Files:** Modify `lib/institutionClient.ts`, `app/org/cohorts/[cohortId]/page.tsx`.

**Interfaces:** Consumes Task 2 routes + the existing Phase-3 `signUpload`/`uploadFile` helpers. Add types `Shelf`/`ShelfItem` and methods `listShelves(cohortId)`, `createShelf(cohortId, {title, order?})`, `updateShelf(cohortId, shelfId, body)`, `deleteShelf(cohortId, shelfId)`, `addShelfItem(cohortId, shelfId, body)`, `updateShelfItem(cohortId, shelfId, itemId, body)`, `deleteShelfItem(cohortId, shelfId, itemId)`.

- [ ] **Step 1: Add types + methods** (mirror the drives/notices methods). `ShelfItem` body for a link item = `{ type:'link', title, url, note? }`; for a file item, first call `uploadFile(file)` (Phase 3 helper) then `{ type:'file', title, s3Key, fileName, mime, note? }`.

- [ ] **Step 2: Add the "Curated shelves" section** to the cohort page after "Notices": load shelves on mount; render each shelf (title + its items, each item shows title + a link to its `url`/file + note); for managers (admin/tpo_head/tpo_coordinator): create-shelf (title), delete-shelf, and per-shelf "add item" with a small form that toggles between **link** (title + url + note) and **file** (title + file input → `uploadFile` → attach + note); delete-item. Refresh after mutations. Match the existing Card/Field/Btn/Chip patterns + 401/403 handling. Keep it compact (this page is large).

- [ ] **Step 3: Build-verify.** `cd "/Users/nirpekshnandan/My Products/scaleup-web" && npx next build 2>&1 | grep -iE "error|Compiled successfully" | head` → "Compiled successfully".

- [ ] **Step 4: Deploy + commit.**
```
SRC="/Users/nirpekshnandan/My Products/scaleup-web"; rm -rf /tmp/sw-deploy && rsync -a --exclude=.git --exclude=node_modules --exclude=.next "$SRC/" /tmp/sw-deploy/ && cd /tmp/sw-deploy && npx vercel --prod --yes 2>&1 | grep -iE "Production|Aliased" | head
cd "$SRC" && git add lib/institutionClient.ts "app/org/cohorts/[cohortId]/page.tsx" && git commit -m "Placement shelves: TPO curated-shelves manager (link + file items)"
```

---

## Task 5: iOS — Library tab shelves + build 206

**Files:** Create `ScaleUp/Features/Placements/Library/PlacementsLibraryApi.swift`; Modify `PlacementsLibraryView.swift`, `project.yml`.

**Interfaces:** Consumes `GET /me/placement/shelves`.

- [ ] **Step 1: API + models.** `Codable` `PlacementShelf { id ("_id"), title, order: Int?, items: [PlacementShelfItem] }` and `PlacementShelfItem { id ("_id"), type, title, note: String?, fileName: String?, mime: String?, url: String? }` (Identifiable). `func fetchShelves() async throws -> [PlacementShelf]` (GET `/me/placement/shelves`). Mirror `PlacementsCampusApi.fetchCompanies()`.

- [ ] **Step 2: Render.** Replace the placeholder cards in `PlacementsLibraryView.swift` with the real shelves: on `.task` fetch; render each shelf as a titled section with its items (title + note; tap opens `url` via openURL; a file glyph for `type=="file"`, a link glyph for `type=="link"`). Empty state: "No shelves yet — your TPO will add prep material here." Keep the "Ask Compass" card (it's fine) or drop it — your call, but do not break the view.

- [ ] **Step 3: Bump build.** `project.yml` 205 → 206.

- [ ] **Step 4: Compile-verify.** `cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && /opt/homebrew/bin/xcodegen generate && xcodebuild -scheme ScaleUp -destination 'generic/platform=iOS' -configuration Debug build CODE_SIGNING_ALLOWED=NO -quiet 2>&1 | tail -25` → BUILD SUCCEEDED.

- [ ] **Step 5: Commit.** `cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && git add -A && git commit -m "Placement shelves: Library tab curated shelves from /me/placement/shelves; build 206"`

---

## Task 6: Android — Library tab shelves

**Files:** Create `src/features/placements/api/shelvesApi.ts`; Modify the Library tab screen (from `src/features/placements/core/PlacementsMainTabs.tsx`, likely `src/features/placements/screens/PlacementsLibraryScreen.tsx`).

**Interfaces:** Consumes `GET /me/placement/shelves`.

- [ ] **Step 1: API.** `export type PlacementShelfItem = { _id: string; type: 'link'|'file'; title: string; note?: string|null; fileName?: string|null; mime?: string|null; url?: string|null }`; `export type PlacementShelf = { _id: string; title: string; order?: number; items: PlacementShelfItem[] }`; `export async function fetchShelves(): Promise<PlacementShelf[]>` (GET `/me/placement/shelves`, unwrap `.data`). Mirror `companiesApi.ts`.

- [ ] **Step 2: Render** the Library screen: replace the placeholder with real shelves (fetch on mount/focus): each shelf titled, its items listed (title + note, link/file glyph, tap → `Linking.openURL(url)`); empty state. Match existing tokens.

- [ ] **Step 3: Type-check.** `cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && npx tsc --noEmit 2>&1 | tail -25` → exit 0.

- [ ] **Step 4: Commit.** `cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && git add -A && git commit -m "Placement shelves: Library tab curated shelves from /me/placement/shelves"`

---

## Final steps (after all 6 tasks)

- [ ] Confirm box on the new backend commit + pm2 online (EC2 Instance Connect).
- [ ] iOS: archive + upload **build 206** to TestFlight (established pipeline + inline auth flags).
- [ ] Android: leave for the team's APK build.
- [ ] Report: TPO builds shelves with link + file items on the cohort page; students browse them in the Library tab. This completes the placement student-experience redesign (Phases 1–4).

## Self-Review notes (addressed)

- **Spec coverage:** Module 6 fully covered — models (T1), TPO shelves+items CRUD with parent-shelf scope check (T2), student endpoint with presigned file urls (T3), web manager with link+file items reusing the Phase-3 upload primitive (T4), Library tab on both apps (T5,T6).
- **Reuse, not rebuild:** file uploads reuse `POST /uploads/sign` + `uploadFile` (Phase 3) and `generateDownloadURL` (s3.js) — no new S3 code. Student file reads are presigned GET, raw `s3Key` never returned.
- **Scope isolation:** item mutations verify the parent shelf is in `{institutionId(from token), cohortId, _id}` before touching items; student query filters by institutionId+cohortId from enrollment. Field whitelist on shelf + item writes.
- **Type consistency:** shelf/item JSON consistent across backend, web (TPO sees s3Key), apps (student sees presigned url + fileName/mime). Item `type` enum `link|file` identical everywhere.
