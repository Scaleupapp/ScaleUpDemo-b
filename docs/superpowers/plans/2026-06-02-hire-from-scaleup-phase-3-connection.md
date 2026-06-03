# Hire from ScaleUp — Phase 3 (Connection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Gate-3 handshake — a contact-tier employer expresses interest in an anonymized candidate; the candidate approves or declines; on approval ONLY, identity + contact + the real proof badge are revealed mutually. Plus the candidate inbox, the employer's sent list, and a minimal admin connections view. Backend, flag-gated.

**Architecture:** A `ConnectionRequest` state machine (`requested → approved | declined | expired`), a **pure** `connectionViewService` that is the single PII gate (reveals candidate/employer identity ONLY when `status==='approved'`), and a `connectionService` that loads the related docs and enforces ownership + idempotency. Two employer routes, three candidate routes, one admin route.

**Tech Stack:** Node/Express, Mongoose, existing `employerAuth`/`requireContactTier`, learner `auth`, `rbac('admin')`, `FEATURE_EMPLOYER_MARKETPLACE` flag. Tests: `node <path>`, no DB, `module.exports._fn` seams.

**Phase 1/2 context (do NOT change):**
- `TalentProfile`: `{ _id, userId, objectiveId, optedIn, status, snapshot:{ roleLabel, proofToken, ... } }`.
- `EmployerAccount`: `{ _id, companyName, name, email, approvalStatus }`.
- `User`: `{ firstName, lastName, email, phone }`.
- `src/middleware/employerAuth.js`: `employerAuth` (sets `req.employer={employerId,emailVerified,approvalStatus}`), `requireContactTier` (403 unless approved).
- `src/routes/employer/search.js` exports `flagGuard`; `src/routes/v2/talent.js` exports `flagGuard` (candidate side).
- `src/services/employer/talentAnonymizer.js`: `anonHandle(id)`.
- Proof URL: `${process.env.PUBLIC_WEB_URL || 'https://scaleup-web-seven.vercel.app'}/r/<token>`.

---

## File Structure

**Create:**
- `src/models/ConnectionRequest.js`
- `src/services/employer/connectionViewService.js` — PURE projections (the PII gate): `employerView`, `candidateView`.
- `src/services/employer/connectionService.js` — `expressInterest`, `respond`, `listForEmployer`, `listForCandidate`.
- `src/routes/employer/connections.js` — `POST /candidates/:id/interest`, `GET /connections`.
- `src/routes/v2/talentConnections.js` — `GET /connections`, `POST /connections/:id/approve|decline`.
- Tests under `src/test/employer/`.

**Modify:**
- `src/app.js` — mount the employer connections router (same `/api/employer` base) + the candidate connections router (`/api/v2/you/talent/connections`).
- `src/routes/admin.js` — add `GET /connections` (abuse monitoring).

---

## Task 1: `ConnectionRequest` model

**Files:**
- Create: `src/models/ConnectionRequest.js`
- Test: `src/test/employer/connectionModel.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/connectionModel.test.js
'use strict';
const assert = require('assert');
const mongoose = require('mongoose');
const ConnectionRequest = require('../../models/ConnectionRequest');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }
const oid = () => new mongoose.Types.ObjectId();

ok('defaults to requested', () => {
  const c = new ConnectionRequest({ employerId: oid(), candidateUserId: oid(), talentProfileId: oid(), objectiveId: oid() });
  assert.strictEqual(c.status, 'requested');
});
ok('status enum rejects junk', () => {
  const c = new ConnectionRequest({ employerId: oid(), candidateUserId: oid(), talentProfileId: oid(), objectiveId: oid(), status: 'nope' });
  assert.ok(c.validateSync().errors.status);
});
ok('required parties', () => {
  const c = new ConnectionRequest({});
  const e = c.validateSync().errors;
  assert.ok(e.employerId && e.candidateUserId && e.talentProfileId);
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Create the model**

```js
// src/models/ConnectionRequest.js
'use strict';
const mongoose = require('mongoose');

// Gate-3: an employer's interest in a candidate. Identity/contact is revealed
// (by connectionViewService) ONLY when status === 'approved'.
const ConnectionRequestSchema = new mongoose.Schema(
  {
    employerId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployerAccount', required: true, index: true },
    candidateUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    talentProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'TalentProfile', required: true },
    objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective' },
    roleContext: { type: String, trim: true },   // what the employer is hiring for
    message: { type: String, trim: true },        // employer's note to the candidate
    status: { type: String, enum: ['requested', 'approved', 'declined', 'expired'], default: 'requested', index: true },
    respondedAt: { type: Date },
  },
  { timestamps: true }
);
// idempotency: one live request per (employer, candidate, objective)
ConnectionRequestSchema.index({ employerId: 1, candidateUserId: 1, objectiveId: 1 }, { unique: true });

module.exports = mongoose.model('ConnectionRequest', ConnectionRequestSchema);
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/models/ConnectionRequest.js src/test/employer/connectionModel.test.js
git commit -m "feat(employer): ConnectionRequest model (Phase 3)"
```

---

## Task 2: `connectionViewService` — the PII gate (pure)

**Files:**
- Create: `src/services/employer/connectionViewService.js`
- Test: `src/test/employer/connectionView.test.js`

Pure projections. `employerView` reveals the CANDIDATE's name/email/phone/proof ONLY when approved. `candidateView` masks the employer until approved, then reveals company/name/email. Takes already-loaded docs so it's trivially testable.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/connectionView.test.js
'use strict';
const assert = require('assert');
const { employerView, candidateView } = require('../../services/employer/connectionViewService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

const profile = { _id: '0123456789abcdef01234567', snapshot: { roleLabel: 'Backend Engineer', proofToken: 'PTOKEN' } };
const candidate = { firstName: 'Priya', lastName: 'Sharma', email: 'priya@x.com', phone: '+91999' };
const employer = { companyName: 'TechCo', name: 'Aarti', email: 'aarti@techco.com' };

ok('employerView pending: NO candidate PII', () => {
  const v = employerView({ _id: 'c1', status: 'requested', message: 'hi', createdAt: new Date() }, profile, candidate);
  const json = JSON.stringify(v);
  assert.ok(!json.includes('Priya') && !json.includes('priya@x.com') && !json.includes('+91999'));
  assert.ok(v.handle.startsWith('Candidate #'));
  assert.strictEqual(v.status, 'requested');
  assert.strictEqual(v.reveal, undefined);
});
ok('employerView approved: reveals candidate contact + proof url', () => {
  const v = employerView({ _id: 'c1', status: 'approved', createdAt: new Date() }, profile, candidate);
  assert.strictEqual(v.reveal.name, 'Priya Sharma');
  assert.strictEqual(v.reveal.email, 'priya@x.com');
  assert.strictEqual(v.reveal.phone, '+91999');
  assert.ok(v.reveal.proofUrl.includes('/r/PTOKEN'));
});
ok('candidateView pending: employer masked', () => {
  const v = candidateView({ _id: 'c1', status: 'requested', roleContext: 'Backend Engineer', message: 'hi', createdAt: new Date() }, employer);
  const json = JSON.stringify(v);
  assert.ok(!json.includes('TechCo') && !json.includes('aarti@techco.com'));
  assert.strictEqual(v.employer, 'A verified employer');
  assert.strictEqual(v.roleContext, 'Backend Engineer');
  assert.strictEqual(v.reveal, undefined);
});
ok('candidateView approved: reveals employer', () => {
  const v = candidateView({ _id: 'c1', status: 'approved', createdAt: new Date() }, employer);
  assert.strictEqual(v.reveal.companyName, 'TechCo');
  assert.strictEqual(v.reveal.email, 'aarti@techco.com');
});
console.log(`# tests 4\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/services/employer/connectionViewService.js
'use strict';
const { anonHandle } = require('./talentAnonymizer');

const WEB_BASE = process.env.PUBLIC_WEB_URL || 'https://scaleup-web-seven.vercel.app';

// Employer's view of a connection. Candidate identity/contact ONLY when approved.
function employerView(conn, profile, candidate) {
  const base = {
    connectionId: String(conn._id),
    status: conn.status,
    handle: anonHandle(profile && profile._id),
    roleLabel: profile && profile.snapshot ? profile.snapshot.roleLabel : null,
    message: conn.message || null,
    createdAt: conn.createdAt || null,
    respondedAt: conn.respondedAt || null,
  };
  if (conn.status === 'approved' && candidate) {
    const proofToken = profile && profile.snapshot ? profile.snapshot.proofToken : null;
    base.reveal = {
      name: [candidate.firstName, candidate.lastName].filter(Boolean).join(' ').trim() || null,
      email: candidate.email || null,
      phone: candidate.phone || null,
      proofUrl: proofToken ? `${WEB_BASE}/r/${proofToken}` : null,
    };
  }
  return base;
}

// Candidate's view of an incoming connection. Employer masked until approved.
function candidateView(conn, employer) {
  const base = {
    connectionId: String(conn._id),
    status: conn.status,
    employer: 'A verified employer',
    roleContext: conn.roleContext || null,
    message: conn.message || null,
    createdAt: conn.createdAt || null,
    respondedAt: conn.respondedAt || null,
  };
  if (conn.status === 'approved' && employer) {
    base.reveal = {
      companyName: employer.companyName || null,
      name: employer.name || null,
      email: employer.email || null,
    };
  }
  return base;
}

module.exports = { employerView, candidateView };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/connectionViewService.js src/test/employer/connectionView.test.js
git commit -m "feat(employer): connection view projections — PII gate on approval (Phase 3)"
```

---

## Task 3: `connectionService.expressInterest`

**Files:**
- Create: `src/services/employer/connectionService.js`
- Test: `src/test/employer/expressInterest.test.js`

Loads the TalentProfile (must be opted-in active → else `PROFILE_UNAVAILABLE`), idempotently creates a `ConnectionRequest` keyed on (employer, candidate, objective). DB via `_fn` seams.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/expressInterest.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/connectionService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  const profile = { _id: 'p1', userId: 'u1', objectiveId: 'o1', optedIn: true, status: 'active' };
  await ok('creates a request idempotently', async () => {
    svc._loadProfile = async () => profile;
    let upserted = null;
    svc._upsertConnection = async (key, patch) => { upserted = { key, patch }; return { _id: 'c1', ...key, ...patch.$setOnInsert, status: 'requested' }; };
    const r = await svc.expressInterest('e1', 'p1', { message: 'hi', roleContext: 'Backend Engineer' });
    assert.strictEqual(upserted.key.employerId, 'e1');
    assert.strictEqual(upserted.key.candidateUserId, 'u1');
    assert.strictEqual(upserted.key.objectiveId, 'o1');
    assert.strictEqual(upserted.patch.$setOnInsert.message, 'hi');
    assert.strictEqual(r.status, 'requested');
  });
  await ok('profile not in pool -> PROFILE_UNAVAILABLE', async () => {
    svc._loadProfile = async () => null;
    await assert.rejects(() => svc.expressInterest('e1', 'pX', {}), /PROFILE_UNAVAILABLE/);
  });
  await ok('paused profile -> PROFILE_UNAVAILABLE', async () => {
    svc._loadProfile = async () => ({ _id: 'p1', userId: 'u1', optedIn: false, status: 'paused' });
    await assert.rejects(() => svc.expressInterest('e1', 'p1', {}), /PROFILE_UNAVAILABLE/);
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/services/employer/connectionService.js
'use strict';

async function _loadProfile(talentProfileId) {
  const TalentProfile = require('../../models/TalentProfile');
  return TalentProfile.findOne({ _id: talentProfileId, optedIn: true, status: 'active' }).lean();
}
async function _upsertConnection(key, patch) {
  const ConnectionRequest = require('../../models/ConnectionRequest');
  return ConnectionRequest.findOneAndUpdate(key, patch, { upsert: true, new: true, setDefaultsOnInsert: true });
}

// Contact-tier employer expresses interest. Idempotent per (employer, candidate, objective).
// The candidate profile must still be in the pool (opted-in + active).
async function expressInterest(employerId, talentProfileId, { message, roleContext } = {}) {
  const profile = await module.exports._loadProfile(talentProfileId);
  if (!profile) throw new Error('PROFILE_UNAVAILABLE');
  const key = { employerId, candidateUserId: profile.userId, objectiveId: profile.objectiveId };
  const patch = { $setOnInsert: { talentProfileId: profile._id, message: message || '', roleContext: roleContext || '', status: 'requested' } };
  return module.exports._upsertConnection(key, patch);
}

module.exports = { expressInterest, _loadProfile, _upsertConnection };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/connectionService.js src/test/employer/expressInterest.test.js
git commit -m "feat(employer): expressInterest — idempotent, pool-gated (Phase 3)"
```

---

## Task 4: `connectionService.respond` + list views

**Files:**
- Modify: `src/services/employer/connectionService.js`
- Test: `src/test/employer/connectionRespond.test.js`

`respond` enforces candidate ownership + the `requested → approved|declined` transition. `listForCandidate`/`listForEmployer` load related docs and map through `connectionViewService`.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/connectionRespond.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/connectionService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  await ok('approve sets status + respondedAt when owned + pending', async () => {
    const conn = { _id: 'c1', candidateUserId: 'u1', status: 'requested', save: async function(){ this._saved = true; return this; } };
    svc._loadConnectionById = async () => conn;
    const r = await svc.respond('c1', 'u1', 'approved');
    assert.strictEqual(r.status, 'approved');
    assert.ok(r.respondedAt);
    assert.ok(conn._saved);
  });
  await ok('not owner -> NOT_FOUND', async () => {
    svc._loadConnectionById = async () => ({ _id: 'c1', candidateUserId: 'uOTHER', status: 'requested' });
    await assert.rejects(() => svc.respond('c1', 'u1', 'approved'), /NOT_FOUND/);
  });
  await ok('already responded -> ALREADY_RESPONDED', async () => {
    svc._loadConnectionById = async () => ({ _id: 'c1', candidateUserId: 'u1', status: 'approved' });
    await assert.rejects(() => svc.respond('c1', 'u1', 'declined'), /ALREADY_RESPONDED/);
  });
  await ok('bad decision -> BAD_DECISION', async () => {
    svc._loadConnectionById = async () => ({ _id: 'c1', candidateUserId: 'u1', status: 'requested' });
    await assert.rejects(() => svc.respond('c1', 'u1', 'maybe'), /BAD_DECISION/);
  });
  await ok('listForCandidate maps via candidateView (masked when pending)', async () => {
    svc._findForCandidate = async () => [{ _id: 'c1', status: 'requested', employerId: 'e1', roleContext: 'BE', message: 'hi' }];
    svc._loadEmployer = async () => ({ companyName: 'TechCo', name: 'Aarti', email: 'a@techco.com' });
    const list = await svc.listForCandidate('u1');
    assert.strictEqual(list[0].employer, 'A verified employer');
    assert.ok(!JSON.stringify(list).includes('TechCo'));
  });
  await ok('listForEmployer reveals candidate only when approved', async () => {
    svc._findForEmployer = async () => [
      { _id: 'c1', status: 'requested', talentProfileId: 'p1', candidateUserId: 'u1' },
      { _id: 'c2', status: 'approved', talentProfileId: 'p2', candidateUserId: 'u2' },
    ];
    svc._loadProfile = async (id) => ({ _id: id, snapshot: { roleLabel: 'BE', proofToken: 'T' } });
    svc._loadCandidate = async (id) => ({ firstName: 'Priya', lastName: 'S', email: 'p@x.com', phone: '+91' });
    const list = await svc.listForEmployer('e1');
    assert.strictEqual(list[0].reveal, undefined);          // pending: masked
    assert.strictEqual(list[1].reveal.name, 'Priya S');     // approved: revealed
    assert.ok(!JSON.stringify(list[0]).includes('Priya'));  // no leak on pending
  });
  console.log(`# tests 6\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement (append to `connectionService.js`)**

```js
const views = require('./connectionViewService');

async function _loadConnectionById(id) {
  const ConnectionRequest = require('../../models/ConnectionRequest');
  return ConnectionRequest.findById(id);
}
async function _findForCandidate(candidateUserId) {
  const ConnectionRequest = require('../../models/ConnectionRequest');
  return ConnectionRequest.find({ candidateUserId }).sort({ createdAt: -1 }).lean();
}
async function _findForEmployer(employerId) {
  const ConnectionRequest = require('../../models/ConnectionRequest');
  return ConnectionRequest.find({ employerId }).sort({ createdAt: -1 }).lean();
}
async function _loadEmployer(id) {
  const EmployerAccount = require('../../models/EmployerAccount');
  return EmployerAccount.findById(id).select('companyName name email').lean();
}
async function _loadCandidate(id) {
  const User = require('../../models/User');
  return User.findById(id).select('firstName lastName email phone').lean();
}

// Candidate approves/declines an incoming request they own.
async function respond(connectionId, candidateUserId, decision) {
  if (decision !== 'approved' && decision !== 'declined') throw new Error('BAD_DECISION');
  const conn = await module.exports._loadConnectionById(connectionId);
  if (!conn || String(conn.candidateUserId) !== String(candidateUserId)) throw new Error('NOT_FOUND');
  if (conn.status !== 'requested') throw new Error('ALREADY_RESPONDED');
  conn.status = decision;
  conn.respondedAt = new Date();
  await conn.save();
  return conn;
}

// Candidate inbox — employer masked unless approved.
async function listForCandidate(candidateUserId) {
  const rows = await module.exports._findForCandidate(candidateUserId);
  return Promise.all(rows.map(async (c) => {
    const employer = c.status === 'approved' ? await module.exports._loadEmployer(c.employerId) : null;
    return views.candidateView(c, employer);
  }));
}

// Employer's sent list — candidate revealed only on approval.
async function listForEmployer(employerId) {
  const rows = await module.exports._findForEmployer(employerId);
  return Promise.all(rows.map(async (c) => {
    const profile = await module.exports._loadProfile(c.talentProfileId);
    const candidate = c.status === 'approved' ? await module.exports._loadCandidate(c.candidateUserId) : null;
    return views.employerView(c, profile, candidate);
  }));
}

module.exports.respond = respond;
module.exports.listForCandidate = listForCandidate;
module.exports.listForEmployer = listForEmployer;
module.exports._loadConnectionById = _loadConnectionById;
module.exports._findForCandidate = _findForCandidate;
module.exports._findForEmployer = _findForEmployer;
module.exports._loadEmployer = _loadEmployer;
module.exports._loadCandidate = _loadCandidate;
```

**Note:** `listForEmployer` calls `module.exports._loadProfile` — but `_loadProfile` (from Task 3) does a pool-gated query (`optedIn:true, status:'active'`). A paused candidate's approved connection would then load `profile=null`. That is acceptable (the role label just shows null) and does NOT leak — the reveal still works off `candidate`. Keep `_loadProfile` as-is.

- [ ] **Step 4: Run it — expect PASS.** Re-run Task 3's test (no regression).

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/connectionService.js src/test/employer/connectionRespond.test.js
git commit -m "feat(employer): respond + list connection views (Phase 3)"
```

---

## Task 5: Employer connection routes

**Files:**
- Create: `src/routes/employer/connections.js`
- Modify: `src/app.js`
- Test: `src/test/employer/connectionEmployerRoutes.test.js`

`POST /api/employer/candidates/:id/interest` (flagGuard → employerAuth → **requireContactTier**), `GET /api/employer/connections` (flagGuard → employerAuth, browse tier ok to view own sent list).

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/connectionEmployerRoutes.test.js
'use strict';
const assert = require('assert');
const h = require('../../routes/employer/connections');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function res(){ return { code:200, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  h._svc.expressInterest = async (eid, pid, body) => ({ _id: 'c1', status: 'requested', eid, pid, body });
  await ok('interest 200', async () => {
    const r = res();
    await h.interestHandler({ employer: { employerId: 'e1' }, params: { id: 'p1' }, body: { message: 'hi' } }, r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.data.status, 'requested');
  });
  await ok('interest PROFILE_UNAVAILABLE -> 404', async () => {
    h._svc.expressInterest = async () => { throw new Error('PROFILE_UNAVAILABLE'); };
    const r = res();
    await h.interestHandler({ employer: { employerId: 'e1' }, params: { id: 'pX' }, body: {} }, r);
    assert.strictEqual(r.code, 404);
    assert.strictEqual(r.body.code, 'PROFILE_UNAVAILABLE');
  });
  h._svc.listForEmployer = async () => [{ connectionId: 'c1', status: 'requested' }];
  await ok('connections list 200', async () => {
    const r = res();
    await h.listHandler({ employer: { employerId: 'e1' } }, r);
    assert.strictEqual(r.body.data[0].connectionId, 'c1');
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/routes/employer/connections.js
'use strict';
const router = require('express').Router();
const featureFlags = require('../../config/featureFlags');
const { employerAuth, requireContactTier } = require('../../middleware/employerAuth');
const svc = require('../../services/employer/connectionService');

function flagGuard(req, res, next) {
  if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
  return next();
}

async function interestHandler(req, res) {
  try {
    const out = await svc.expressInterest(req.employer.employerId, req.params.id, req.body || {});
    return res.status(200).json({ success: true, data: { connectionId: String(out._id), status: out.status } });
  } catch (err) {
    if (err.message === 'PROFILE_UNAVAILABLE') return res.status(404).json({ success: false, code: 'PROFILE_UNAVAILABLE', message: 'This candidate is no longer available.' });
    console.error('[employer/interest]', err.message);
    return res.status(500).json({ success: false, message: 'Could not send interest.' });
  }
}
async function listHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.listForEmployer(req.employer.employerId) }); }
  catch (err) { console.error('[employer/connections]', err.message); return res.status(500).json({ success: false, message: 'Could not load.' }); }
}

router.post('/candidates/:id/interest', flagGuard, employerAuth, requireContactTier, interestHandler);
router.get('/connections', flagGuard, employerAuth, listHandler);

module.exports = router;
module.exports.interestHandler = interestHandler;
module.exports.listHandler = listHandler;
module.exports.flagGuard = flagGuard;
module.exports._svc = svc;
```

- [ ] **Step 4: Mount in `src/app.js`** (after the `app.use('/api/employer', require('./routes/employer/search'))` line):

```js
app.use('/api/employer', require('./routes/employer/connections'));
```

- [ ] **Step 5: Run it — expect PASS.** Confirm load: `node -e "require('./src/routes/employer/connections'); console.log('ok')"`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/employer/connections.js src/app.js src/test/employer/connectionEmployerRoutes.test.js
git commit -m "feat(employer): express-interest + sent-connections routes (contact-tier) (Phase 3)"
```

---

## Task 6: Candidate connection routes

**Files:**
- Create: `src/routes/v2/talentConnections.js`
- Modify: `src/app.js`
- Test: `src/test/employer/connectionCandidateRoutes.test.js`

`GET /api/v2/you/talent/connections` (inbox), `POST .../connections/:id/approve`, `POST .../connections/:id/decline`. Behind `flagGuard` → learner `auth`.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/connectionCandidateRoutes.test.js
'use strict';
const assert = require('assert');
const h = require('../../routes/v2/talentConnections');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function res(){ return { code:200, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  h._svc.listForCandidate = async () => [{ connectionId: 'c1', employer: 'A verified employer', status: 'requested' }];
  await ok('inbox 200 + masked', async () => {
    const r = res();
    await h.inboxHandler({ user: { userId: 'u1' } }, r);
    assert.strictEqual(r.body.data[0].employer, 'A verified employer');
  });
  h._svc.respond = async (cid, uid, dec) => ({ _id: cid, status: dec });
  await ok('approve 200', async () => {
    const r = res();
    await h.approveHandler({ user: { userId: 'u1' }, params: { id: 'c1' } }, r);
    assert.strictEqual(r.body.data.status, 'approved');
  });
  await ok('decline 200', async () => {
    const r = res();
    await h.declineHandler({ user: { userId: 'u1' }, params: { id: 'c1' } }, r);
    assert.strictEqual(r.body.data.status, 'declined');
  });
  await ok('respond NOT_FOUND -> 404', async () => {
    h._svc.respond = async () => { throw new Error('NOT_FOUND'); };
    const r = res();
    await h.approveHandler({ user: { userId: 'u1' }, params: { id: 'cX' } }, r);
    assert.strictEqual(r.code, 404);
  });
  await ok('respond ALREADY_RESPONDED -> 409', async () => {
    h._svc.respond = async () => { throw new Error('ALREADY_RESPONDED'); };
    const r = res();
    await h.declineHandler({ user: { userId: 'u1' }, params: { id: 'c1' } }, r);
    assert.strictEqual(r.code, 409);
  });
  console.log(`# tests 5\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/routes/v2/talentConnections.js
'use strict';
const router = require('express').Router();
const featureFlags = require('../../config/featureFlags');
const auth = require('../../middleware/auth');
const svc = require('../../services/employer/connectionService');

function flagGuard(req, res, next) {
  if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
  return next();
}

async function inboxHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.listForCandidate(req.user.userId) }); }
  catch (err) { console.error('[talent/connections]', err.message); return res.status(500).json({ success: false, message: 'Could not load.' }); }
}
function _respondHandler(decision) {
  return async function (req, res) {
    try {
      const out = await svc.respond(req.params.id, req.user.userId, decision);
      return res.status(200).json({ success: true, data: { connectionId: String(out._id), status: out.status } });
    } catch (err) {
      if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Request not found.' });
      if (err.message === 'ALREADY_RESPONDED') return res.status(409).json({ success: false, code: 'ALREADY_RESPONDED', message: 'You already responded to this.' });
      console.error('[talent/respond]', err.message);
      return res.status(500).json({ success: false, message: 'Could not respond.' });
    }
  };
}
const approveHandler = _respondHandler('approved');
const declineHandler = _respondHandler('declined');

router.get('/', flagGuard, auth, inboxHandler);
router.post('/:id/approve', flagGuard, auth, approveHandler);
router.post('/:id/decline', flagGuard, auth, declineHandler);

module.exports = router;
module.exports.inboxHandler = inboxHandler;
module.exports.approveHandler = approveHandler;
module.exports.declineHandler = declineHandler;
module.exports.flagGuard = flagGuard;
module.exports._svc = svc;
```

- [ ] **Step 4: Mount in `src/app.js`.** In `src/routes/v2/index.js`, add BEFORE `router.use('/you/talent', require('./talent'))`:

```js
router.use('/you/talent/connections', require('./talentConnections'));
```
(More-specific prefix first, same lesson as Phase 1. The file is `src/routes/v2/talentConnections.js`.)

- [ ] **Step 5: Run it — expect PASS.** Confirm load: `node -e "require('./src/routes/v2'); console.log('ok')"`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/v2/talentConnections.js src/routes/v2/index.js src/test/employer/connectionCandidateRoutes.test.js
git commit -m "feat(employer): candidate connection inbox + approve/decline routes (Phase 3)"
```

---

## Task 7: Admin connections view (abuse monitoring)

**Files:**
- Modify: `src/routes/admin.js`
- Test: `src/test/employer/connectionAdmin.test.js`

Minimal read-only list (counts + recent, no candidate PII beyond what admins already see) so the team can spot abuse. Reuses the existing `auth, rbac('admin')` guard + the flag check pattern from Phase 1.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/connectionAdmin.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/connectionService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  await ok('adminList returns counts + rows', async () => {
    svc._adminFind = async () => [
      { _id: 'c1', employerId: 'e1', status: 'requested', createdAt: new Date() },
      { _id: 'c2', employerId: 'e1', status: 'approved', createdAt: new Date() },
    ];
    const out = await svc.adminList();
    assert.strictEqual(out.total, 2);
    assert.strictEqual(out.byStatus.requested, 1);
    assert.strictEqual(out.byStatus.approved, 1);
    assert.strictEqual(out.rows.length, 2);
  });
  console.log(`# tests 1\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Add `adminList` to `connectionService.js`**

```js
async function _adminFind() {
  const ConnectionRequest = require('../../models/ConnectionRequest');
  return ConnectionRequest.find({}).sort({ createdAt: -1 }).limit(200)
    .select('employerId candidateUserId status createdAt respondedAt roleContext').lean();
}
// Read-only abuse-monitoring rollup for admins.
async function adminList() {
  const rows = await module.exports._adminFind();
  const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  return { total: rows.length, byStatus, rows };
}
module.exports.adminList = adminList;
module.exports._adminFind = _adminFind;
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Add the admin route** in `src/routes/admin.js` (after the employer-approval routes; `auth, rbac('admin')` + `featureFlags` already in scope from Phase 1):

```js
router.get('/connections', async (req, res) => {
  try {
    if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
    return res.json({ success: true, data: await require('../services/employer/connectionService').adminList() });
  } catch (e) { console.error('[admin/connections]', e.message); return res.status(500).json({ success: false }); }
});
```
(If `featureFlags` is not already required at the top of `admin.js` from Phase 1, add `const featureFlags = require('../config/featureFlags');`.)

- [ ] **Step 6: Confirm admin loads:** `node -e "require('./src/routes/admin'); console.log('ok')"`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin.js src/services/employer/connectionService.js src/test/employer/connectionAdmin.test.js
git commit -m "feat(employer): admin connections monitoring view (Phase 3)"
```

---

## Task 8: Suite green + push

- [ ] **Step 1: Run the whole employer suite**

```bash
for f in src/test/employer/*.test.js; do printf "%-36s " "$(basename $f)"; node "$f" 2>&1 | grep -E "# (tests|pass|fail)" | tr '\n' ' '; echo; done
```
Expected: every file `# fail 0`.

- [ ] **Step 2: Parse + route load**

```bash
for f in src/models/ConnectionRequest.js src/services/employer/connection*.js src/routes/employer/connections.js src/routes/v2/talentConnections.js src/app.js; do node --check "$f" || echo "FAIL $f"; done && echo PARSE_OK
node -e "require('./src/routes/v2'); require('./src/routes/employer/connections'); require('./src/routes/admin'); console.log('routes load')"
```

- [ ] **Step 3: Push**

```bash
git push origin master
```

---

## Self-Review (done by plan author)

**Spec coverage (Phase 3):** ConnectionRequest state machine (Task 1 ✓), the 3-gate reveal — identity/contact ONLY on candidate approval (Task 2 PII gate ✓, enforced in list views Task 4 ✓), express-interest contact-tier gated + idempotent (Tasks 3, 5 ✓), candidate approve/decline with ownership (Tasks 4, 6 ✓), employer sent list + candidate inbox (Task 4 ✓), real proof-badge link revealed on approval (Task 2 `proofUrl` ✓), admin abuse monitoring (Task 7 ✓), flag-gated (every route ✓). The in-app chat thread + push/email notifications are Phase 4.

**Placeholder scan:** none — complete runnable code each step.

**Type/name consistency:** `connectionViewService.employerView/candidateView` signatures consistent across Tasks 2 and 4. `connectionService` `_fn` seams consistent. Reuses Phase-1/2 shapes (`TalentProfile.userId/objectiveId/snapshot.proofToken`, `EmployerAccount.{companyName,name,email}`, `User.{firstName,lastName,email,phone}`). Status strings (`requested/approved/declined/expired`) consistent model↔service↔routes. HTTP codes: PROFILE_UNAVAILABLE→404, NOT_FOUND→404, ALREADY_RESPONDED→409.

**Security note for executor:** Task 2 is the PII gate — its tests assert NO candidate identity/contact appears in any non-approved view. Do NOT weaken those. `respond` MUST check ownership (`candidateUserId` match) before mutating. The reveal happens only in the `status==='approved'` branch.
