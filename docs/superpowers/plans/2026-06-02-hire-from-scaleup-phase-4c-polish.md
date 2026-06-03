# Hire from ScaleUp — Phase 4C (Polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Backend-only.

**Goal:** Make the marketplace pilot-ready: **notifications** (candidate gets a push when an employer is interested; employer gets an email when a candidate approves), a **durable DPDP audit-log** (every profile view + reveal recorded, not just a console line), and **analytics** events at every key marketplace moment.

**Architecture:** Two new services (`marketplaceAuditService` over a new `MarketplaceAuditLog` model; `marketplaceNotificationService` over the existing `notificationService` + employer email), plus best-effort `logEvent` analytics. All wiring into the Phase 1–3 flows is **best-effort** — a failed notification/audit/analytics call must NEVER break the user-facing request (wrap in try/catch, fire-and-forget).

**Tech Stack:** Node/Express/Mongoose. Reuse: `notificationService.sendToUser(userId, {title,body,data})` (in-app + APNs push), `diagnosticTelemetryService.logEvent(event, props)`, the employer email stub pattern (`employerAuthService._sendEmail`). Tests: `node <path>`, no DB, `module.exports._fn` seams.

**Phase 1–3 integration points (do NOT change behavior, only add best-effort hooks):**
- `connectionService.expressInterest(employerId, talentProfileId, body)` → returns the connection (has `candidateUserId`, `objectiveId`). **Hook:** notify candidate + audit + event.
- `connectionService.respond(connectionId, candidateUserId, decision)` → returns the connection. **Hook:** on `approved` notify employer + audit reveal + event; on `declined` event.
- `employerSearchService.getCandidate(id)` → **Hook:** audit view + event.
- `employerSearchService.search(filters)` → **Hook:** event.
- `talentProfileService.optIn/optOut` → **Hook:** event.

---

## File Structure

**Create:**
- `src/models/MarketplaceAuditLog.js` — `{ kind, actorType, actorId, subjectUserId, talentProfileId, connectionId, meta, createdAt }`.
- `src/services/employer/marketplaceAuditService.js` — `logInterest`, `logView`, `logReveal` (best-effort writes).
- `src/services/employer/marketplaceNotificationService.js` — `notifyCandidateOfInterest`, `notifyEmployerOfApproval`.
- Tests under `src/test/employer/`.

**Modify (best-effort hooks only):**
- `src/services/employer/connectionService.js` — wire audit + notify + event into `expressInterest` + `respond`.
- `src/services/employer/employerSearchService.js` — wire audit-view + event into `getCandidate`, event into `search`.
- `src/services/employer/talentProfileService.js` — event into `optIn`/`optOut`.

---

## Task 1: `MarketplaceAuditLog` model

**Files:** Create `src/models/MarketplaceAuditLog.js`; Test `src/test/employer/auditModel.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/auditModel.test.js
'use strict';
const assert = require('assert');
const mongoose = require('mongoose');
const MarketplaceAuditLog = require('../../models/MarketplaceAuditLog');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('kind enum + required actor', () => {
  const a = new MarketplaceAuditLog({ kind: 'reveal', actorType: 'employer', actorId: new mongoose.Types.ObjectId() });
  assert.strictEqual(a.validateSync(), undefined);
});
ok('rejects bad kind', () => {
  const a = new MarketplaceAuditLog({ kind: 'nope', actorType: 'employer', actorId: new mongoose.Types.ObjectId() });
  assert.ok(a.validateSync().errors.kind);
});
ok('rejects bad actorType', () => {
  const a = new MarketplaceAuditLog({ kind: 'view', actorType: 'alien', actorId: new mongoose.Types.ObjectId() });
  assert.ok(a.validateSync().errors.actorType);
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Create the model**

```js
// src/models/MarketplaceAuditLog.js
'use strict';
const mongoose = require('mongoose');

// DPDP audit trail for the talent marketplace: who viewed/contacted/was-revealed, when.
const MarketplaceAuditLogSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['view', 'interest', 'reveal'], required: true, index: true },
    actorType: { type: String, enum: ['employer', 'candidate', 'system'], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    subjectUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // the candidate
    talentProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'TalentProfile' },
    connectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectionRequest' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);
MarketplaceAuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('MarketplaceAuditLog', MarketplaceAuditLogSchema);
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/models/MarketplaceAuditLog.js src/test/employer/auditModel.test.js
git commit -m "feat(employer): MarketplaceAuditLog model (Phase 4C)"
```

---

## Task 2: `marketplaceAuditService`

**Files:** Create `src/services/employer/marketplaceAuditService.js`; Test `src/test/employer/auditService.test.js`

Best-effort writers — never throw into the caller.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/auditService.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/marketplaceAuditService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  let written = null;
  svc._write = async (doc) => { written = doc; return doc; };
  await ok('logReveal writes a reveal record', async () => {
    await svc.logReveal({ employerId: 'e1', candidateUserId: 'u1', connectionId: 'c1' });
    assert.strictEqual(written.kind, 'reveal');
    assert.strictEqual(written.actorType, 'employer');
    assert.strictEqual(written.actorId, 'e1');
    assert.strictEqual(written.subjectUserId, 'u1');
  });
  await ok('logView writes a view record', async () => {
    await svc.logView({ employerId: 'e1', talentProfileId: 'p1' });
    assert.strictEqual(written.kind, 'view');
  });
  await ok('never throws when the write fails', async () => {
    svc._write = async () => { throw new Error('db down'); };
    await svc.logInterest({ employerId: 'e1', candidateUserId: 'u1', connectionId: 'c1' }); // must resolve, not reject
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/services/employer/marketplaceAuditService.js
'use strict';

async function _write(doc) {
  const MarketplaceAuditLog = require('../../models/MarketplaceAuditLog');
  return MarketplaceAuditLog.create(doc);
}
async function _safe(doc) {
  try { await module.exports._write(doc); }
  catch (e) { console.warn('[marketplace-audit] write failed:', e.message); }
}

function logView({ employerId, talentProfileId }) {
  return _safe({ kind: 'view', actorType: 'employer', actorId: employerId, talentProfileId });
}
function logInterest({ employerId, candidateUserId, talentProfileId, connectionId }) {
  return _safe({ kind: 'interest', actorType: 'employer', actorId: employerId, subjectUserId: candidateUserId, talentProfileId, connectionId });
}
function logReveal({ employerId, candidateUserId, connectionId }) {
  return _safe({ kind: 'reveal', actorType: 'employer', actorId: employerId, subjectUserId: candidateUserId, connectionId });
}

module.exports = { logView, logInterest, logReveal, _write };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/marketplaceAuditService.js src/test/employer/auditService.test.js
git commit -m "feat(employer): marketplace audit service — best-effort DPDP trail (Phase 4C)"
```

---

## Task 3: `marketplaceNotificationService`

**Files:** Create `src/services/employer/marketplaceNotificationService.js`; Test `src/test/employer/marketplaceNotify.test.js`

Candidate → push/in-app via `notificationService`. Employer → email (stub log, same as the pilot magic-link mailer). Best-effort.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/marketplaceNotify.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/marketplaceNotificationService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  let pushed = null;
  svc._sendToUser = async (userId, payload) => { pushed = { userId, payload }; };
  await ok('notifyCandidateOfInterest pushes (no employer identity leaked)', async () => {
    await svc.notifyCandidateOfInterest('u1', { roleContext: 'Backend Engineer' });
    assert.strictEqual(pushed.userId, 'u1');
    assert.ok(/verified employer/i.test(pushed.payload.title + pushed.payload.body));
    assert.ok(!JSON.stringify(pushed.payload).toLowerCase().includes('techco')); // no employer name
    assert.strictEqual(pushed.payload.data.type, 'marketplace_interest');
  });

  let emailed = null;
  svc._loadEmployerEmail = async () => 'hr@techco.com';
  svc._sendEmail = async (to, subject, body) => { emailed = { to, subject, body }; };
  await ok('notifyEmployerOfApproval emails the employer', async () => {
    await svc.notifyEmployerOfApproval('e1', { connectionId: 'c1' });
    assert.strictEqual(emailed.to, 'hr@techco.com');
    assert.ok(/accepted|connect/i.test(emailed.subject + emailed.body));
  });

  await ok('never throws when push fails', async () => {
    svc._sendToUser = async () => { throw new Error('apns down'); };
    await svc.notifyCandidateOfInterest('u1', {}); // resolves
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement**

```js
// src/services/employer/marketplaceNotificationService.js
'use strict';

async function _sendToUser(userId, payload) {
  const notificationService = require('../notificationService');
  return notificationService.sendToUser(userId, payload);
}
async function _loadEmployerEmail(employerId) {
  const EmployerAccount = require('../../models/EmployerAccount');
  const acc = await EmployerAccount.findById(employerId).select('email').lean();
  return acc ? acc.email : null;
}
async function _sendEmail(to, subject, body) {
  // PILOT: log. Replace with a real mailer alongside the employer magic-link mailer.
  console.log(`[marketplace-email] to=${to} subject="${subject}"`);
  return true;
}

// Candidate gets a push when an employer is interested — employer identity stays masked.
async function notifyCandidateOfInterest(candidateUserId, { roleContext } = {}) {
  try {
    const role = roleContext ? ` for ${roleContext}` : '';
    await module.exports._sendToUser(candidateUserId, {
      title: 'A verified employer is interested',
      body: `An employer wants to connect${role}. Review and approve in your inbox.`,
      data: { type: 'marketplace_interest', deepLink: 'scaleup://talent/connections' },
    });
  } catch (e) { console.warn('[marketplace-notify] candidate push failed:', e.message); }
}

// Employer gets an email when a candidate approves (sign in to see the reveal).
async function notifyEmployerOfApproval(employerId, { connectionId } = {}) {
  try {
    const email = await module.exports._loadEmployerEmail(employerId);
    if (!email) return;
    await module.exports._sendEmail(email, 'A candidate accepted your interest',
      'Good news — a candidate approved your connection. Sign in to ScaleUp Hire to see their details and reach out.');
  } catch (e) { console.warn('[marketplace-notify] employer email failed:', e.message); }
}

module.exports = { notifyCandidateOfInterest, notifyEmployerOfApproval, _sendToUser, _loadEmployerEmail, _sendEmail };
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/marketplaceNotificationService.js src/test/employer/marketplaceNotify.test.js
git commit -m "feat(employer): marketplace notifications — candidate push + employer email (Phase 4C)"
```

---

## Task 4: Wire hooks into `connectionService`

**Files:** Modify `src/services/employer/connectionService.js`; Test `src/test/employer/connectionHooks.test.js`

Best-effort hooks: `expressInterest` → audit `logInterest` + `notifyCandidateOfInterest` + `logEvent('marketplace.interest_sent')`; `respond` approved → audit `logReveal` + `notifyEmployerOfApproval` + `logEvent('marketplace.connection_approved')`; declined → `logEvent('marketplace.connection_declined')`. All wrapped so they never break the call.

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/connectionHooks.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/connectionService');
const audit = require('../../services/employer/marketplaceAuditService');
const notify = require('../../services/employer/marketplaceNotificationService');
const telemetry = require('../../services/diagnosticTelemetryService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  const events = [];
  telemetry._setEmitter((evt, props) => events.push({ evt, props }));
  let interestNotified = false, revealAudited = false, employerNotified = false;
  audit.logInterest = async () => {}; audit.logReveal = async () => { revealAudited = true; };
  notify.notifyCandidateOfInterest = async () => { interestNotified = true; };
  notify.notifyEmployerOfApproval = async () => { employerNotified = true; };

  await ok('expressInterest fires candidate notify + interest event', async () => {
    svc._loadProfile = async () => ({ _id: 'p1', userId: 'u1', objectiveId: 'o1', optedIn: true, status: 'active' });
    svc._upsertConnection = async () => ({ _id: 'c1', candidateUserId: 'u1', objectiveId: 'o1', talentProfileId: 'p1', roleContext: 'BE', status: 'requested' });
    await svc.expressInterest('e1', 'p1', { roleContext: 'BE' });
    assert.ok(interestNotified);
    assert.ok(events.find((e) => e.evt === 'marketplace.interest_sent'));
  });

  await ok('respond approved fires reveal audit + employer notify + event', async () => {
    const conn = { _id: 'c1', candidateUserId: 'u1', employerId: 'e1', status: 'requested', save: async function(){ return this; } };
    svc._loadConnectionById = async () => conn;
    await svc.respond('c1', 'u1', 'approved');
    assert.ok(revealAudited && employerNotified);
    assert.ok(events.find((e) => e.evt === 'marketplace.connection_approved'));
  });

  await ok('respond declined fires declined event (no reveal/notify)', async () => {
    const conn = { _id: 'c2', candidateUserId: 'u1', employerId: 'e1', status: 'requested', save: async function(){ return this; } };
    svc._loadConnectionById = async () => conn;
    await svc.respond('c2', 'u1', 'declined');
    assert.ok(events.find((e) => e.evt === 'marketplace.connection_declined'));
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** — in `connectionService.js`, add a best-effort hook helper and call it. At the TOP add requires (lazy inside helpers to avoid cycles):

```js
function _hook(fn) { Promise.resolve().then(fn).catch((e) => console.warn('[marketplace-hook]', e.message)); }
function _event(evt, props) { try { require('../diagnosticTelemetryService').logEvent(evt, props); } catch (_) {} }
```

In `expressInterest`, AFTER computing the connection (before `return`):
```js
  const conn = await module.exports._upsertConnection(key, patch);
  _hook(() => require('./marketplaceAuditService').logInterest({ employerId, candidateUserId: profile.userId, talentProfileId: profile._id, connectionId: conn._id }));
  _hook(() => require('./marketplaceNotificationService').notifyCandidateOfInterest(profile.userId, { roleContext }));
  _event('marketplace.interest_sent', { employerId: String(employerId), candidateUserId: String(profile.userId) });
  return conn;
```
(Adjust `expressInterest` to capture the upsert result in `conn` and return it.)

In `respond`, AFTER `await conn.save();`:
```js
  if (decision === 'approved') {
    _hook(() => require('./marketplaceAuditService').logReveal({ employerId: conn.employerId, candidateUserId: conn.candidateUserId, connectionId: conn._id }));
    _hook(() => require('./marketplaceNotificationService').notifyEmployerOfApproval(conn.employerId, { connectionId: conn._id }));
    _event('marketplace.connection_approved', { connectionId: String(conn._id), employerId: String(conn.employerId) });
  } else {
    _event('marketplace.connection_declined', { connectionId: String(conn._id) });
  }
  return conn;
```
(Keep the existing `[audit] connection.approved` console line from Phase 3 — the durable reveal log now supplements it.)

- [ ] **Step 4: Run it — expect PASS.** Re-run the Phase-3 `connectionRespond`/`expressInterest` tests (no regression — the hooks are additive and best-effort; the stubs in those tests don't define audit/notify, but `_hook` swallows errors so they stay green; VERIFY).

- [ ] **Step 5: Commit**

```bash
git add src/services/employer/connectionService.js src/test/employer/connectionHooks.test.js
git commit -m "feat(employer): wire audit + notify + analytics into connection flow (Phase 4C)"
```

---

## Task 5: Wire view-audit + remaining analytics + suite

**Files:** Modify `src/services/employer/employerSearchService.js`, `src/services/employer/talentProfileService.js`; Test `src/test/employer/searchHooks.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/employer/searchHooks.test.js
'use strict';
const assert = require('assert');
const search = require('../../services/employer/employerSearchService');
const audit = require('../../services/employer/marketplaceAuditService');
const telemetry = require('../../services/diagnosticTelemetryService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  const events = [];
  telemetry._setEmitter((evt, props) => events.push(evt));
  let viewAudited = false;
  audit.logView = async () => { viewAudited = true; };

  await ok('getCandidate(viewer) audits a view + fires candidate_view event', async () => {
    search._findOne = async () => ({ _id: 'p1', snapshot: { roleLabel: 'BE' } });
    await search.getCandidate('p1', { employerId: 'e1' });
    assert.ok(viewAudited);
    assert.ok(events.includes('marketplace.candidate_view'));
  });
  await ok('search fires a search event', async () => {
    search._find = async () => [];
    await search.search({}, { employerId: 'e1' });
    assert.ok(events.includes('marketplace.search'));
  });
  console.log(`# tests 2\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** — in `employerSearchService.js`:
  - Add `function _event(evt, props){ try { require('../diagnosticTelemetryService').logEvent(evt, props); } catch(_){} }` and `function _hook(fn){ Promise.resolve().then(fn).catch(()=>{}); }`.
  - Change `getCandidate(id)` → `getCandidate(id, ctx = {})`: after a non-null row, `if (ctx.employerId) { _hook(() => require('./marketplaceAuditService').logView({ employerId: ctx.employerId, talentProfileId: id })); _event('marketplace.candidate_view', { employerId: String(ctx.employerId), talentProfileId: String(id) }); }` then return the anonymized profile.
  - Change `search(filters, opts = {})`: after computing results, `_event('marketplace.search', { employerId: opts.employerId ? String(opts.employerId) : null, total: ranked.length });`.
  - In `src/routes/employer/search.js`, pass `{ employerId: req.employer.employerId }` as the ctx/opts arg to `svc.getCandidate(req.params.id, ...)` and `svc.search(filters, { ...limit, employerId: req.employer.employerId })`.
  - In `talentProfileService.js` `optIn`/`optOut`, after success add `try { require('../diagnosticTelemetryService').logEvent('marketplace.opt_in'|'marketplace.opt_out', { userId: String(userId) }); } catch(_){}`.

- [ ] **Step 4: Run it — expect PASS.** Re-run `search.test.js` + `searchRoutes.test.js` + `talentOptIn.test.js` (the new opts arg is optional → no regression; VERIFY).

- [ ] **Step 5: Full suite + push**

```bash
for f in src/test/employer/*.test.js; do printf "%-34s " "$(basename $f)"; node "$f" 2>&1 | grep -E "# (tests|pass|fail)" | tr '\n' ' '; echo; done
for f in src/models/MarketplaceAuditLog.js src/services/employer/*.js src/routes/employer/search.js; do node --check "$f" || echo "FAIL $f"; done && echo PARSE_OK
git add -A && git commit -m "feat(employer): view audit + opt-in/search analytics (Phase 4C)" && git push origin master
```

---

## Self-Review (plan author)

**Spec coverage (Phase 4C):** notifications — candidate push on interest (Task 3+4 ✓), employer email on approval (Task 3+4 ✓); durable audit-log — view/interest/reveal recorded in a real collection (Tasks 1,2,4,5 ✓); analytics — opt_in/opt_out/search/candidate_view/interest_sent/connection_approved/connection_declined events (Tasks 4,5 ✓).

**Best-effort everywhere:** every hook is `_hook`(fire-and-forget)/`_event`(try-catch)/`_safe`(audit)/try-catch(notify) — a failure in audit/notify/analytics can NEVER break express-interest, respond, search, or getCandidate. The Phase 1–3 tests stay green because the hooks swallow errors even when their deps aren't stubbed.

**No PII in candidate notification:** the push says "a verified employer" — never the company name (Task 3 test asserts this).

**Type/name consistency:** `marketplaceAuditService.{logView,logInterest,logReveal}` + `marketplaceNotificationService.{notifyCandidateOfInterest,notifyEmployerOfApproval}` used consistently in Tasks 4,5. `getCandidate(id, ctx)` / `search(filters, opts)` extended signatures are backward-compatible (optional 2nd arg).

**Note for executor:** keep hooks AFTER the core mutation/return value is computed, never before. Verify the Phase 1–3 employer tests stay green after wiring (the additive optional args + swallowed-error hooks must not regress them).
