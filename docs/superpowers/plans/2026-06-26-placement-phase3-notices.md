# Placement Phase 3 — TPO Notices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the TPO post announcements/notices to a cohort (with an optional link and/or file attachment + a pin flag), see how many students have read each, and let placement students read them in the Campus tab with an unread badge — replacing the "TPO notices" placeholder.

**Architecture:** Two additive Mongo models — `InstitutionNotice` (cohort-scoped) and `NoticeRead` (per-student read state). TPO CRUD via a new `src/routes/institution/notices.js` router; a shared presigned-upload endpoint via a new `src/routes/institution/uploads.js` (reuses the existing `src/config/s3.js` `generateUploadURL`). Students read via new routes on the existing student router (`/api/v2/me`), which already resolves cohort from enrollment; attachments are served as short-lived presigned GET URLs.

**Tech Stack:** Backend — Node/Express/Mongoose; tests use `node:test` + `supertest` + `router._deps` DI stubs (no DB, no AWS). Web — Next.js/React/TS (`scaleup-web`). iOS — Swift/SwiftUI (`ScaleUpDemo-f`). Android — React Native/TS (`ScaleUpAndroid`).

## Global Constraints

- **Zero D2C impact.** Additive models + routes only. TPO routes behind `institutionAuth` + `institutionScope`; student routes cohort-scoped via enrollment. No D2C changes.
- **Scope isolation.** Every TPO query/mutation scoped by `institutionScope(req)` (institutionId from token, never body). A TPO of institution A must not read/write institution B's notices. Students only see notices for their enrolled cohort(s) and only their own read state.
- **Roles:** create/update/delete notices + request an upload URL = `institution_admin`, `tpo_head`, `tpo_coordinator`. List notices (TPO) = any institution role.
- **Field whitelist on writes** (no mass-assignment of `institutionId`/`cohortId`/`_id`/`createdBy`).
- **Run backend tests with Node's runner.** `node --test <file>` (node v20 via nvm; if not on PATH use `~/.nvm/versions/node/v20.20.0/bin/node --test <file>`).
- **Deploy:** backend = commit + push `master`; web = git-less `vercel --prod`; iOS = build bump 204 → 205 + TestFlight at the end; Android = commit `main`, APK left to the team.
- **Endpoint contract (apps + web depend on these):**
  - Upload: `POST /api/institution/uploads/sign` body `{ fileName, contentType }` → `{ success, data: { uploadUrl, s3Key } }`.
  - TPO notices: `POST/GET /api/institution/cohorts/:cohortId/notices`, `PATCH/DELETE …/notices/:noticeId`. GET returns `{ success, data: { notices: NoticeWithCounts[], total } }` where each notice has `readCount` and `total` is the cohort's enrollment count.
  - Student: `GET /api/v2/me/placement/notices` → `{ success, data: StudentNotice[] }` sorted pinned-first then `createdAt` desc, each with `read: boolean` and, when attached, `attachment: { fileName, mime, url }` (presigned GET). `POST /api/v2/me/placement/notices/:noticeId/read` → `{ success: true }`.
  - `InstitutionNotice` JSON: `{ _id, cohortId, title, body, pinned, link, attachment: { s3Key, fileName, mime } | null, createdAt, updatedAt }`.

---

## File Structure

**Backend:**
- Create `src/models/InstitutionNotice.js`, `src/models/NoticeRead.js`.
- Create `src/services/institution/noticeService.js` (TPO CRUD + read counts).
- Create `src/routes/institution/notices.js` (TPO routes), `src/routes/institution/uploads.js` (presign).
- Modify `src/routes/institution/index.js` (mount the two new routers).
- Modify `src/routes/institution/studentAssessments.js` (student notice list + mark-read).
- Tests: `src/test/institution/notice.model.test.js`, `notices.route.test.js`, `uploads.route.test.js`, `placementNotices.route.test.js`.

**Web:** `lib/institutionClient.ts` (types + methods incl. upload helper) + `app/org/cohorts/[cohortId]/page.tsx` (Notices composer + read counts).

**iOS:** `ScaleUp/Features/Placements/Campus/PlacementsCampusApi.swift` (extend with notices) + `PlacementsCampusView.swift` (notices card) + `project.yml` build 205.

**Android:** `src/features/placements/api/noticesApi.ts` + the placement Campus screen.

---

## Task 1: Backend — InstitutionNotice + NoticeRead models

**Files:** Create `src/models/InstitutionNotice.js`, `src/models/NoticeRead.js`; Test `src/test/institution/notice.model.test.js`.

**Interfaces:**
- Produces: `InstitutionNotice` (required `institutionId`,`cohortId`,`title`,`body`; `pinned` default false; optional `link`; optional `attachment` subdoc `{ s3Key, fileName, mime }`; `createdBy`; timestamps). `NoticeRead` (`noticeId`,`userId`,`readAt` default now; unique compound index).

- [ ] **Step 1: Write the failing test.**
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const InstitutionNotice = require('../../models/InstitutionNotice');
const NoticeRead = require('../../models/NoticeRead');
const oid = '507f1f77bcf86cd799439011';

test('InstitutionNotice requires institutionId, cohortId, title, body', () => {
  const err = new InstitutionNotice({}).validateSync();
  assert.ok(err.errors.institutionId && err.errors.cohortId && err.errors.title && err.errors.body);
});
test('InstitutionNotice defaults pinned=false and keeps attachment', () => {
  const n = new InstitutionNotice({ institutionId: oid, cohortId: oid, title: 'T', body: 'B', attachment: { s3Key: 'k', fileName: 'f.pdf', mime: 'application/pdf' } });
  assert.strictEqual(n.pinned, false);
  assert.strictEqual(n.attachment.fileName, 'f.pdf');
});
test('NoticeRead requires noticeId and userId and defaults readAt', () => {
  const err = new NoticeRead({}).validateSync();
  assert.ok(err.errors.noticeId && err.errors.userId);
  const r = new NoticeRead({ noticeId: oid, userId: oid });
  assert.ok(r.readAt instanceof Date);
});
```

- [ ] **Step 2: Run to confirm failure.** `node --test src/test/institution/notice.model.test.js` → FAIL (modules missing).

- [ ] **Step 3: Implement models.**
`src/models/InstitutionNotice.js`:
```js
const mongoose = require('mongoose');
const InstitutionNoticeSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true, index: true },
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true, trim: true },
  pinned: { type: Boolean, default: false },
  link: { type: String, trim: true },
  attachment: {
    type: new mongoose.Schema({
      s3Key: { type: String, required: true },
      fileName: { type: String, trim: true },
      mime: { type: String, trim: true },
    }, { _id: false }),
    default: undefined,
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });
InstitutionNoticeSchema.index({ institutionId: 1, cohortId: 1, pinned: -1, createdAt: -1 });
module.exports = mongoose.models.InstitutionNotice || mongoose.model('InstitutionNotice', InstitutionNoticeSchema);
```
`src/models/NoticeRead.js`:
```js
const mongoose = require('mongoose');
const NoticeReadSchema = new mongoose.Schema({
  noticeId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionNotice', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  readAt: { type: Date, default: Date.now },
});
NoticeReadSchema.index({ noticeId: 1, userId: 1 }, { unique: true });
module.exports = mongoose.models.NoticeRead || mongoose.model('NoticeRead', NoticeReadSchema);
```

- [ ] **Step 4: Run to confirm pass.** `node --test src/test/institution/notice.model.test.js` → PASS (3).

- [ ] **Step 5: Commit.** `git add src/models/InstitutionNotice.js src/models/NoticeRead.js src/test/institution/notice.model.test.js && git commit -m "Placement notices: InstitutionNotice + NoticeRead models"`

---

## Task 2: Backend — shared presigned-upload route

**Files:** Create `src/routes/institution/uploads.js`; Modify `src/routes/institution/index.js`; Test `src/test/institution/uploads.route.test.js`.

**Interfaces:**
- Consumes: `src/config/s3.js` `generateUploadURL(key, contentType)`. DI seam `router._deps = { s3, generateUploadURL }` for tests.
- Produces: `POST /api/institution/uploads/sign` → `{ success, data: { uploadUrl, s3Key } }`. Key shape `institution/<institutionId>/uploads/<timestamp>-<safeFileName>`. Gated to write roles.

- [ ] **Step 1: Write the failing test.**
```js
'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');
function stubLoadUser(institutionId, role) { institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId, role, status: 'active', tokenVersion: 0, scope: {} }); }
const uploads = require('../../routes/institution/uploads');
function tok(i, r) { return signInstitutionToken({ _id: 'u1', institutionId: i, role: r, tokenVersion: 0 }); }
function appAs(i, r) { stubLoadUser(i, r); const a = express(); a.use(express.json()); a.use('/api/institution', uploads); return a; }

test('viewer cannot request an upload url (403)', async () => {
  const res = await request(appAs('inst-A', 'viewer')).post('/api/institution/uploads/sign')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`).send({ fileName: 'a.pdf', contentType: 'application/pdf' });
  assert.strictEqual(res.status, 403);
});
test('tpo_coordinator gets a presigned url + scoped key', async () => {
  uploads._deps = { generateUploadURL: async (key, ct) => `https://signed/${key}?ct=${ct}` };
  const res = await request(appAs('inst-A', 'tpo_coordinator')).post('/api/institution/uploads/sign')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_coordinator')}`).send({ fileName: 'my notes.pdf', contentType: 'application/pdf' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.s3Key.startsWith('institution/inst-A/uploads/'));
  assert.ok(res.body.data.uploadUrl.includes('signed/institution/inst-A/uploads/'));
  uploads._deps = null;
});
test('missing fileName → 400', async () => {
  const res = await request(appAs('inst-A', 'tpo_head')).post('/api/institution/uploads/sign')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`).send({ contentType: 'application/pdf' });
  assert.strictEqual(res.status, 400);
});
```

- [ ] **Step 2: Run to confirm failure.** `node --test src/test/institution/uploads.route.test.js` → FAIL.

- [ ] **Step 3: Implement the route.** `src/routes/institution/uploads.js`:
```js
'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const router = express.Router();
router._deps = null;
function getGen(deps) { return (deps && deps.generateUploadURL) || require('../../config/s3').generateUploadURL; }
function safeName(n) { return String(n || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }

router.post('/uploads/sign', institutionAuth, requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const scope = institutionScope(req);
    const { fileName, contentType } = req.body || {};
    if (!fileName) return res.status(400).json({ success: false, code: 'VALIDATION', message: 'fileName is required.' });
    const key = `institution/${scope.institutionId}/uploads/${Date.now()}-${safeName(fileName)}`;
    const uploadUrl = await getGen(router._deps)(key, contentType || 'application/octet-stream');
    return res.status(200).json({ success: true, data: { uploadUrl, s3Key: key } });
  } catch (err) {
    console.error('[institution/uploads:sign]', err.message);
    return res.status(500).json({ success: false, message: 'Could not create upload URL.' });
  }
});
module.exports = router;
```

- [ ] **Step 4: Mount it.** In `src/routes/institution/index.js`, add `router.use('/', require('./uploads'));` alongside the other `router.use('/', …)` lines.

- [ ] **Step 5: Run to confirm pass.** `node --test src/test/institution/uploads.route.test.js` → PASS (3).

- [ ] **Step 6: Commit.** `git add src/routes/institution/uploads.js src/routes/institution/index.js src/test/institution/uploads.route.test.js && git commit -m "Placement notices: shared presigned-upload endpoint (POST /uploads/sign)"`

---

## Task 3: Backend — TPO notice CRUD + read counts

**Files:** Create `src/services/institution/noticeService.js`, `src/routes/institution/notices.js`; Modify `src/routes/institution/index.js`; Test `src/test/institution/notices.route.test.js`.

**Interfaces:**
- Consumes: models (Task 1); `getService(router._deps)` DI pattern (mirror `org.js`).
- Produces (service): `createNotice(scope, cohortId, body, deps)`, `listNotices(scope, cohortId, deps)` (→ `{ notices: [...], total }` where each notice carries `readCount` and `total` is the cohort enrollment count), `updateNotice(scope, cohortId, noticeId, body, deps)` (404 throw `NOTICE_NOT_FOUND`), `deleteNotice(scope, cohortId, noticeId, deps)` (404). Whitelist `{ title, body, pinned, link, attachment }`.
- Produces (routes): `POST/GET /cohorts/:cohortId/notices`, `PATCH/DELETE /cohorts/:cohortId/notices/:noticeId`.

- [ ] **Step 1: Write the failing route tests.** `src/test/institution/notices.route.test.js` (copy `org.route.test.js` helpers `stubLoadUser`/`tok`/`appAs`, mounting `require('../../routes/institution/notices')`):
```js
test('viewer cannot create a notice (403)', async () => {
  const res = await request(appAs('inst-A','viewer')).post('/api/institution/cohorts/c1/notices')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`).send({ title: 'T', body: 'B' });
  assert.strictEqual(res.status, 403); notices._deps = null;
});
test('tpo_coordinator creates notice; scope from token, cohort from path', async () => {
  let captured = null;
  notices._deps = { noticeService: { createNotice: async (scope, cohortId, body) => { captured = { scope, cohortId, body }; return { _id: 'n1', ...body }; } } };
  const res = await request(appAs('inst-A','tpo_coordinator')).post('/api/institution/cohorts/c1/notices')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_coordinator')}`).send({ title: 'T', body: 'B', pinned: true, institutionId: 'EVIL' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(captured.scope.institutionId, 'inst-A');
  assert.strictEqual(captured.cohortId, 'c1');
  assert.strictEqual(captured.body.title, 'T');
  notices._deps = null;
});
test('GET notices returns service payload (any role)', async () => {
  notices._deps = { noticeService: { listNotices: async () => ({ notices: [{ _id: 'n1', title: 'T', readCount: 2 }], total: 5 }) } };
  const res = await request(appAs('inst-A','viewer')).get('/api/institution/cohorts/c1/notices')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.notices[0].readCount, 2);
  assert.strictEqual(res.body.data.total, 5);
  notices._deps = null;
});
test('DELETE unknown notice → 404', async () => {
  notices._deps = { noticeService: { deleteNotice: async () => { throw new Error('NOTICE_NOT_FOUND'); } } };
  const res = await request(appAs('inst-A','tpo_head')).delete('/api/institution/cohorts/c1/notices/nX')
    .set('Authorization', `Bearer ${tok('inst-A','tpo_head')}`);
  assert.strictEqual(res.status, 404); notices._deps = null;
});
```

- [ ] **Step 2: Run to confirm failure.** `node --test src/test/institution/notices.route.test.js` → FAIL.

- [ ] **Step 3: Implement the service.** `src/services/institution/noticeService.js`:
```js
'use strict';
const NOTICE_FIELDS = ['title', 'body', 'pinned', 'link', 'attachment'];
function pick(body = {}) { const o = {}; for (const k of NOTICE_FIELDS) if (body[k] !== undefined) o[k] = body[k]; return o; }
function models(deps) {
  return {
    Notice: (deps && deps.InstitutionNotice) || require('../../models/InstitutionNotice'),
    NoticeRead: (deps && deps.NoticeRead) || require('../../models/NoticeRead'),
    Enrollment: (deps && deps.InstitutionEnrollment) || require('../../models/InstitutionEnrollment'),
  };
}
async function createNotice(scope, cohortId, body, deps) {
  const { Notice } = models(deps);
  return Notice.create({ ...scope, cohortId, ...pick(body) });
}
async function listNotices(scope, cohortId, deps) {
  const { Notice, NoticeRead, Enrollment } = models(deps);
  const nq = Notice.find({ ...scope, cohortId }).sort({ pinned: -1, createdAt: -1 }).limit(500);
  const notices = typeof nq.lean === 'function' ? await nq.lean() : await nq;
  const ids = notices.map((n) => n._id);
  const reads = ids.length ? await NoticeRead.aggregate([{ $match: { noticeId: { $in: ids } } }, { $group: { _id: '$noticeId', c: { $sum: 1 } } }]) : [];
  const readByNotice = {}; for (const r of reads) readByNotice[String(r._id)] = r.c;
  const total = await Enrollment.countDocuments({ ...scope, cohortId });
  return { notices: notices.map((n) => ({ ...n, readCount: readByNotice[String(n._id)] || 0 })), total };
}
async function updateNotice(scope, cohortId, noticeId, body, deps) {
  const { Notice } = models(deps);
  const n = await Notice.findOneAndUpdate({ ...scope, cohortId, _id: noticeId }, { $set: pick(body) }, { new: true });
  if (!n) throw new Error('NOTICE_NOT_FOUND'); return n;
}
async function deleteNotice(scope, cohortId, noticeId, deps) {
  const { Notice, NoticeRead } = models(deps);
  const n = await Notice.findOneAndDelete({ ...scope, cohortId, _id: noticeId });
  if (!n) throw new Error('NOTICE_NOT_FOUND');
  try { await NoticeRead.deleteMany({ noticeId }); } catch (e) { /* best-effort cleanup */ }
  return n;
}
module.exports = { createNotice, listNotices, updateNotice, deleteNotice };
```
(Note: `Enrollment.countDocuments({ ...scope, cohortId })` — confirm the enrollment model is scoped by `institutionId`; if enrollments are keyed only by `cohortId`, count by `{ cohortId }`. Read `src/models/InstitutionEnrollment.js` first and match its fields.)

- [ ] **Step 4: Implement the routes.** `src/routes/institution/notices.js` (mirror `org.js` structure: `router._deps`, `getService`, `institutionAuth`, `requireInstitutionRole`, `institutionScope`):
```js
'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const router = express.Router();
router._deps = null;
function getService(deps) { return (deps && deps.noticeService) || require('../../services/institution/noticeService'); }
const WRITE = requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator');

router.post('/cohorts/:cohortId/notices', institutionAuth, WRITE, async (req, res) => {
  try { const n = await getService(router._deps).createNotice(institutionScope(req), req.params.cohortId, req.body || {});
    return res.status(201).json({ success: true, data: n });
  } catch (err) { if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid notice data.' });
    console.error('[institution/notices:create]', err.message); return res.status(500).json({ success: false, message: 'Could not create notice.' }); }
});
router.get('/cohorts/:cohortId/notices', institutionAuth, async (req, res) => {
  try { const data = await getService(router._deps).listNotices(institutionScope(req), req.params.cohortId);
    return res.status(200).json({ success: true, data });
  } catch (err) { console.error('[institution/notices:list]', err.message); return res.status(500).json({ success: false, message: 'Could not list notices.' }); }
});
router.patch('/cohorts/:cohortId/notices/:noticeId', institutionAuth, WRITE, async (req, res) => {
  try { const n = await getService(router._deps).updateNotice(institutionScope(req), req.params.cohortId, req.params.noticeId, req.body || {});
    return res.status(200).json({ success: true, data: n });
  } catch (err) { if (err.message === 'NOTICE_NOT_FOUND') return res.status(404).json({ success: false, message: 'Notice not found.' });
    if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid notice data.' });
    console.error('[institution/notices:update]', err.message); return res.status(500).json({ success: false, message: 'Could not update notice.' }); }
});
router.delete('/cohorts/:cohortId/notices/:noticeId', institutionAuth, WRITE, async (req, res) => {
  try { await getService(router._deps).deleteNotice(institutionScope(req), req.params.cohortId, req.params.noticeId);
    return res.status(200).json({ success: true });
  } catch (err) { if (err.message === 'NOTICE_NOT_FOUND') return res.status(404).json({ success: false, message: 'Notice not found.' });
    console.error('[institution/notices:delete]', err.message); return res.status(500).json({ success: false, message: 'Could not delete notice.' }); }
});
module.exports = router;
```
Then mount in `src/routes/institution/index.js`: `router.use('/', require('./notices'));`.

- [ ] **Step 5: Run to confirm pass.** `node --test src/test/institution/notices.route.test.js` → PASS (4).

- [ ] **Step 6: Commit.** `git add src/services/institution/noticeService.js src/routes/institution/notices.js src/routes/institution/index.js src/test/institution/notices.route.test.js && git commit -m "Placement notices: TPO CRUD + read counts (scoped, role-gated)"`

---

## Task 4: Backend — student notice list + mark-read

**Files:** Modify `src/routes/institution/studentAssessments.js`; Test `src/test/institution/placementNotices.route.test.js`.

**Interfaces:**
- Consumes: the student router's `getAuth()` + `getEnrollment()`; add DI getters `getNotice()`/`getNoticeRead()` (mirror `getPlacementDrive()`); reuse `src/config/s3.js` `generateDownloadURL` for attachment URLs (DI: `router._deps.generateDownloadURL`).
- Produces: `GET /placement/notices` → cohort notices (pinned-first, createdAt desc) each with `read: boolean` (left-join NoticeRead by this user) and `attachment: { fileName, mime, url }` (presigned GET) when attached. `POST /placement/notices/:noticeId/read` → upsert NoticeRead `{ noticeId, userId }`.

- [ ] **Step 1: Write the failing test.** `src/test/institution/placementNotices.route.test.js` (mirror the companies test's DI mount with `router._deps`):
```js
'use strict';
const test = require('node:test'); const assert = require('node:assert');
const express = require('express'); const request = require('supertest');
const router = require('../../routes/institution/studentAssessments');
function appWith(deps) { router._deps = deps; const a = express(); a.use(express.json()); a.use('/api/v2/me', router); return a; }
const authStub = (userId) => (req, _res, next) => { req.user = { userId }; next(); };

test('notices: cohort-scoped, pinned-first, with read flag + attachment url', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([{ cohortId: 'c1' }]) }) },
    InstitutionNotice: { find: (q) => { assert.deepStrictEqual(q.cohortId.$in, ['c1']); return { sort: () => ({ lean: async () => ([
      { _id: 'n1', title: 'A', pinned: true, attachment: { s3Key: 'k', fileName: 'f.pdf', mime: 'application/pdf' } },
      { _id: 'n2', title: 'B', pinned: false },
    ]) }) }; } },
    NoticeRead: { find: () => ({ lean: async () => ([{ noticeId: 'n2' }]) }) },
    generateDownloadURL: async (key) => `https://signed/${key}`,
  });
  const res = await request(app).get('/api/v2/me/placement/notices');
  assert.strictEqual(res.status, 200);
  const byId = Object.fromEntries(res.body.data.map((n) => [n._id, n]));
  assert.strictEqual(byId.n1.read, false);
  assert.strictEqual(byId.n2.read, true);
  assert.strictEqual(byId.n1.attachment.url, 'https://signed/k');
  router._deps = null;
});

test('mark-read upserts and returns success', async () => {
  let upserted = null;
  const app = appWith({ auth: authStub('stu1'), NoticeRead: { updateOne: async (filter, update, opts) => { upserted = { filter, opts }; return { acknowledged: true }; } } });
  const res = await request(app).post('/api/v2/me/placement/notices/n1/read');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(upserted.filter.noticeId, 'n1');
  assert.strictEqual(upserted.filter.userId, 'stu1');
  assert.strictEqual(upserted.opts.upsert, true);
  router._deps = null;
});

test('notices: empty when no enrollment', async () => {
  const app = appWith({ auth: authStub('stu1'), InstitutionEnrollment: { find: () => ({ lean: async () => ([]) }) } });
  const res = await request(app).get('/api/v2/me/placement/notices');
  assert.deepStrictEqual(res.body.data, []);
  router._deps = null;
});
```

- [ ] **Step 2: Run to confirm failure.** `node --test src/test/institution/placementNotices.route.test.js` → FAIL.

- [ ] **Step 3: Implement.** In `src/routes/institution/studentAssessments.js`, add DI getters:
```js
function getNotice() { return (router._deps && router._deps.InstitutionNotice) || require('../../models/InstitutionNotice'); }
function getNoticeRead() { return (router._deps && router._deps.NoticeRead) || require('../../models/NoticeRead'); }
function getGenDownload() { return (router._deps && router._deps.generateDownloadURL) || require('../../config/s3').generateDownloadURL; }
```
and the routes (before `module.exports`):
```js
// GET /placement/notices — cohort notices with this student's read state.
router.get('/placement/notices', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const Enrollment = getEnrollment();
    const enq = Enrollment.find({ userId });
    const enrollments = typeof enq.lean === 'function' ? await enq.lean() : await enq;
    const cohortIds = enrollments.map((e) => e.cohortId);
    if (!cohortIds.length) return res.status(200).json({ success: true, data: [] });
    const Notice = getNotice();
    const nq = Notice.find({ cohortId: { $in: cohortIds } }).sort({ pinned: -1, createdAt: -1 });
    const notices = typeof nq.lean === 'function' ? await nq.lean() : await nq;
    const NoticeRead = getNoticeRead();
    const rq = NoticeRead.find({ userId, noticeId: { $in: notices.map((n) => n._id) } });
    const reads = typeof rq.lean === 'function' ? await rq.lean() : await rq;
    const readSet = new Set(reads.map((r) => String(r.noticeId)));
    const genDownload = getGenDownload();
    const data = [];
    for (const n of notices) {
      let attachment = null;
      if (n.attachment && n.attachment.s3Key) {
        let url = null;
        try { url = await genDownload(n.attachment.s3Key); } catch (e) { url = null; }
        attachment = { fileName: n.attachment.fileName, mime: n.attachment.mime, url };
      }
      data.push({ _id: n._id, title: n.title, body: n.body, pinned: !!n.pinned, link: n.link || null, attachment, createdAt: n.createdAt, read: readSet.has(String(n._id)) });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[studentAssessments:notices]', err.message);
    return res.status(500).json({ success: false, message: 'Could not list notices.' });
  }
});

// POST /placement/notices/:noticeId/read — mark a notice read (idempotent upsert).
router.post('/placement/notices/:noticeId/read', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const NoticeRead = getNoticeRead();
    await NoticeRead.updateOne({ noticeId: req.params.noticeId, userId }, { $setOnInsert: { readAt: new Date() } }, { upsert: true });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[studentAssessments:notice-read]', err.message);
    return res.status(500).json({ success: false, message: 'Could not mark read.' });
  }
});
```

- [ ] **Step 4: Run to confirm pass.** `node --test src/test/institution/placementNotices.route.test.js` → PASS (3).

- [ ] **Step 5: Full suite + commit + push.**
Run: `node --test src/test/institution/*.test.js` → green.
```
git add src/routes/institution/studentAssessments.js src/test/institution/placementNotices.route.test.js && git commit -m "Placement notices: GET /me/placement/notices + POST .../read (cohort-scoped, read state, signed attachment)"
git push origin master
```

---

## Task 5: Web — Notices composer + read counts

**Files:** Modify `lib/institutionClient.ts`, `app/org/cohorts/[cohortId]/page.tsx`.

**Interfaces:**
- Consumes: Tasks 2 & 3 routes. Add types `InstitutionNotice` (`{ _id, title, body, pinned, link?, attachment?: { s3Key, fileName, mime }, createdAt?, readCount? }`) and methods: `listNotices(cohortId)` → `{ success, data: { notices: InstitutionNotice[]; total: number } }`, `createNotice(cohortId, body)`, `updateNotice(cohortId, id, body)`, `deleteNotice(cohortId, id)`, and `signUpload({ fileName, contentType })` → `{ success, data: { uploadUrl, s3Key } }`. Add a helper `uploadFile(file: File)` that calls `signUpload`, then `fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })`, and returns `{ s3Key, fileName: file.name, mime: file.type }`.

- [ ] **Step 1: Add types + client methods** (mirror the drives methods added in Phase 2). `signUpload` uses `req('POST','/uploads/sign', body)`. `uploadFile` is a plain async function in the client module (not under `institutionApi.req` — it does a raw `fetch` PUT to S3; do NOT send the institution Authorization header to S3).

- [ ] **Step 2: Add the "Notices" section** to the cohort page after "Companies & Drives": load on mount (`loadNotices()` → `listNotices`), render each notice (title, body, a "Pinned" chip when pinned, link, attachment filename link, and `readCount / total read`), and — for managers (admin/tpo_head/tpo_coordinator) — a composer (title required, body required, pin checkbox, optional link, optional file input that calls `uploadFile` then includes the returned `attachment` in `createNotice`), plus delete. Pin/unpin via `updateNotice`. Refresh after mutations. Match the existing card/field/button patterns and 401/403 handling.

- [ ] **Step 3: Build-verify.** `cd "/Users/nirpekshnandan/My Products/scaleup-web" && npx next build 2>&1 | grep -iE "error|Compiled successfully" | head` → "Compiled successfully".

- [ ] **Step 4: Deploy + commit.**
```
SRC="/Users/nirpekshnandan/My Products/scaleup-web"; rm -rf /tmp/sw-deploy && rsync -a --exclude=.git --exclude=node_modules --exclude=.next "$SRC/" /tmp/sw-deploy/ && cd /tmp/sw-deploy && npx vercel --prod --yes 2>&1 | grep -iE "Production|Aliased" | head
cd "$SRC" && git add lib/institutionClient.ts "app/org/cohorts/[cohortId]/page.tsx" && git commit -m "Placement notices: TPO Notices composer (pin/link/file) + read counts"
```

---

## Task 6: iOS — Campus "TPO notices" card + build 205

**Files:** Modify `ScaleUp/Features/Placements/Campus/PlacementsCampusApi.swift`, `PlacementsCampusView.swift`, `project.yml`.

**Interfaces:**
- Consumes: `GET /me/placement/notices`, `POST /me/placement/notices/:id/read`.

- [ ] **Step 1: Extend the API.** Add `Codable` `PlacementNotice { id ("_id"), title, body, pinned: Bool, link: String?, attachment: PlacementNoticeAttachment?, read: Bool }` and `PlacementNoticeAttachment { fileName: String?; mime: String?; url: String? }` (Identifiable). Add `func fetchNotices() async throws -> [PlacementNotice]` and `func markNoticeRead(_ id: String) async throws` (POST, ignore body) to `PlacementsCampusApi`.

- [ ] **Step 2: Render the notices card.** Replace the "TPO notices" placeholder with a real list: on `.task` fetch notices; pinned ones show a pin glyph; unread notices show a dot/badge; tapping a notice marks it read (call `markNoticeRead`, update local state) and, if it has a `link` or `attachment.url`, opens it (openURL). Empty state: "No notices yet — your TPO will post updates here." Keep the (now-real) Company drives card from Phase 2 above it. An overall unread count can title the section (optional).

- [ ] **Step 3: Bump build.** `project.yml` CURRENT_PROJECT_VERSION 204 → 205.

- [ ] **Step 4: Compile-verify.** `cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && /opt/homebrew/bin/xcodegen generate && xcodebuild -scheme ScaleUp -destination 'generic/platform=iOS' -configuration Debug build CODE_SIGNING_ALLOWED=NO -quiet 2>&1 | tail -25` → BUILD SUCCEEDED.

- [ ] **Step 5: Commit.** `cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && git add -A && git commit -m "Placement notices: Campus TPO-notices list (pin, unread, mark-read, link/attachment); build 205"`

---

## Task 7: Android — Campus "TPO notices" card

**Files:** Create `src/features/placements/api/noticesApi.ts`; Modify the placement Campus screen (`src/features/placements/screens/PlacementsCampusScreen.tsx`).

**Interfaces:**
- Consumes: `GET /me/placement/notices`, `POST /me/placement/notices/:id/read`.

- [ ] **Step 1: Create the api.** `export type PlacementNotice = { _id: string; title: string; body: string; pinned: boolean; link?: string | null; attachment?: { fileName?: string; mime?: string; url?: string } | null; read: boolean }`; `export async function fetchNotices(): Promise<PlacementNotice[]>` (GET `/me/placement/notices`, unwrap `.data`); `export async function markNoticeRead(id: string): Promise<void>` (POST `/me/placement/notices/${id}/read`). Mirror `assessmentsApi.ts`.

- [ ] **Step 2: Render the notices card** in the Campus screen: replace the "TPO notices" placeholder with a real list (fetch on mount/focus): pinned first (already sorted by server), pin indicator, unread dot, tap → `markNoticeRead` + update local state + open `link`/`attachment.url` via `Linking.openURL`. Empty state. Keep the Company drives card (Phase 2) above. Match existing tokens.

- [ ] **Step 3: Type-check.** `cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && npx tsc --noEmit 2>&1 | tail -25` → exit 0.

- [ ] **Step 4: Commit.** `cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && git add -A && git commit -m "Placement notices: Campus TPO-notices list (pin, unread, mark-read, link/attachment)"`

---

## Final steps (after all 7 tasks)

- [ ] Confirm box on the new backend commit + pm2 online (EC2 Instance Connect).
- [ ] iOS: archive + upload **build 205** to TestFlight (established pipeline + inline auth flags).
- [ ] Android: leave for the team's APK build.
- [ ] Report: TPO posts notices (pin/link/file) on the cohort page + sees read counts; students read them in Campus with unread badges. Phase 4 (Shelves) remains.

## Self-Review notes (addressed)

- **Spec coverage:** Module 5 fully covered — models (T1), shared presign primitive (T2, reused by Phase 4 shelves), TPO CRUD + read counts (T3), student list + read-ack (T4), web composer with all features incl. file upload (T5), Campus card on both apps with pin/unread/mark-read (T6,T7).
- **S3 gate cleared:** `src/config/s3.js` already exports `generateUploadURL`/`generateDownloadURL`; env present on the box (proven by D2C content). So file attachments ship in this phase (not link-only).
- **Scope isolation tested:** T3 asserts scope-from-token + 404; T4 asserts cohort-from-enrollment, per-user read flag, empty-without-enrollment, and upsert idempotency.
- **Type consistency:** the notice JSON (`_id`, `pinned`, `attachment{fileName,mime,url}` student-side vs `{s3Key,fileName,mime}` TPO-side) is consistent across backend, web, iOS, RN; the TPO sees `s3Key`, the student sees a presigned `url`.
- **Upload security:** the presign route is role-gated and scopes the key under `institution/<institutionId>/`; the browser PUTs directly to S3 without the institution bearer token.
