# TPO Portal W3 — Command-center Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/org/dashboard` from a near-empty seats/role page into a command center: institution **placement % + package hero stats**, the **placement funnel**, **upcoming drives**, and a **"Needs your attention"** action list — each linking to where to act.

**Architecture:** One new institution-scoped aggregate endpoint `GET /api/institution/dashboard` (a `dashboardService` that composes `outcomeService.institutionOutcomes` + enrollment funnel counts + upcoming `PlacementDrive`s + attention counts). The dashboard page consumes it and renders the cockpit with the W1 `_ui` kit.

**Tech Stack:** Backend — Node/Express/Mongoose; `node:test` + DI stubs. Web — Next.js using `app/org/_ui.tsx`.

## Global Constraints

- **Zero D2C impact.** Additive endpoint; institution-scoped (`institutionScope`); read-only; any institution role may read.
- **Backend tests:** `node --test <file>` (node v20 via nvm; else `~/.nvm/...`).
- **Deploy:** backend push `master`; web git-less Vercel.
- **Contract:** `GET /api/institution/dashboard` → `{ success, data: DashboardData }` where
  `DashboardData = { outcomes: OutcomeSummary, funnel: { invited, registered, diagnosticDone, active, placed }, upcomingDrives: DriveLite[], attention: { configuredAssessments, pendingRosters, drivesThisWeek } }`,
  `DriveLite = { _id, name, role?, package?, driveDate?, status, cohortLabel? }`,
  `OutcomeSummary` is the W2 shape `{ cohortSize, placedCount, placementPercent, highestCtc, averageCtc, medianCtc, companiesVisited, statusCounts, branchWise }`.

---

## Task 1: Backend — dashboard aggregate endpoint

**Files:** Create `src/services/institution/dashboardService.js`, `src/routes/institution/dashboard.js`; Modify `src/routes/institution/index.js`; Test `src/test/institution/dashboard.route.test.js`.

**Interfaces:**
- Service: `build(scope, deps)` → `DashboardData`. Composes: `outcomeService.institutionOutcomes(scope)` (→ `.institution` summary + per-cohort, used for funnel `placed` + a cohortLabel map); enrollment counts by status (`InstitutionEnrollment.countDocuments({ ...scope, status })` for invited/registered/diagnostic_done/active); upcoming drives (`PlacementDrive.find({ ...scope })` then filter `driveDate >= now`, sort asc, take 6 — pass `now` in via `deps.now` so the test is deterministic); attention (`Assessment.countDocuments({ ...scope, status: 'configured' })`, pending rosters count via the injected model/service, drives within 7 days of `deps.now`).
- Route: `GET /dashboard` (any institution role) → `{ success, data }`.

- [ ] **Step 1: Failing route test** `src/test/institution/dashboard.route.test.js` (copy `org.route.test.js` helpers; mount `require('../../routes/institution/dashboard')` as `dashboard`; inject `dashboard._deps = { dashboardService: { build: async (scope) => ({...}) } }`):
```js
test('GET /dashboard returns the assembled data (any role); scope from token', async () => {
  let captured = null;
  dashboard._deps = { dashboardService: { build: async (scope) => { captured = scope; return {
    outcomes: { placementPercent: 50, highestCtc: 30, averageCtc: 21, medianCtc: 21, companiesVisited: 3, placedCount: 2, cohortSize: 4, statusCounts: {}, branchWise: [] },
    funnel: { invited: 10, registered: 8, diagnosticDone: 6, active: 5, placed: 2 },
    upcomingDrives: [{ _id: 'd1', name: 'Acme', status: 'open' }],
    attention: { configuredAssessments: 1, pendingRosters: 0, drivesThisWeek: 1 },
  }; } } };
  const res = await request(appAs('inst-A','viewer')).get('/api/institution/dashboard')
    .set('Authorization', `Bearer ${tok('inst-A','viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(captured.institutionId, 'inst-A');
  assert.strictEqual(res.body.data.funnel.invited, 10);
  assert.strictEqual(res.body.data.outcomes.placementPercent, 50);
  dashboard._deps = null;
});
```

- [ ] **Step 2: Failing service test** in the same file — test `build` assembly with DI stubs:
```js
const dashboardService = require('../../services/institution/dashboardService');
test('dashboardService.build assembles funnel + upcoming drives + attention', async () => {
  const NOW = new Date('2026-07-01T00:00:00Z');
  const data = await dashboardService.build({ institutionId: 'inst-A' }, {
    now: NOW,
    outcomeService: { institutionOutcomes: async () => ({ institution: { placedCount: 2, placementPercent: 50 }, cohorts: [{ cohortId: 'c1', label: 'CSE 2026' }] }) },
    InstitutionEnrollment: { countDocuments: async (q) => ({ invited: 10, registered: 8, diagnostic_done: 6, active: 5 }[q.status] ?? 0) },
    PlacementDrive: { find: () => ({ lean: async () => ([
      { _id: 'd1', name: 'Acme', driveDate: new Date('2026-07-03'), status: 'open', cohortId: 'c1' },        // upcoming, this week
      { _id: 'd2', name: 'Globex', driveDate: new Date('2026-06-20'), status: 'closed', cohortId: 'c1' },    // past
      { _id: 'd3', name: 'Initech', driveDate: new Date('2026-08-15'), status: 'upcoming', cohortId: 'c1' }, // upcoming, not this week
    ]) }) },
    Assessment: { countDocuments: async () => 1 },
    pendingRostersCount: async () => 0,
  });
  assert.strictEqual(data.funnel.invited, 10);
  assert.strictEqual(data.funnel.placed, 2);
  assert.deepStrictEqual(data.upcomingDrives.map((d) => d._id), ['d1', 'd3']); // future only, sorted asc; not d2
  assert.strictEqual(data.upcomingDrives[0].cohortLabel, 'CSE 2026');
  assert.strictEqual(data.attention.configuredAssessments, 1);
  assert.strictEqual(data.attention.drivesThisWeek, 1); // only d1 within 7 days
});
```

- [ ] **Step 3: Run → FAIL.** `node --test src/test/institution/dashboard.route.test.js`

- [ ] **Step 4: Implement the service** `src/services/institution/dashboardService.js`:
```js
'use strict';
function models(deps) {
  return {
    outcomeService: (deps && deps.outcomeService) || require('./outcomeService'),
    Enrollment: (deps && deps.InstitutionEnrollment) || require('../../models/InstitutionEnrollment'),
    Drive: (deps && deps.PlacementDrive) || require('../../models/PlacementDrive'),
    Assessment: (deps && deps.Assessment) || require('../../models/Assessment'),
    pendingRostersCount: (deps && deps.pendingRostersCount) || (async (scope) => {
      const RosterUpload = require('../../models/RosterUpload');
      try { return await RosterUpload.countDocuments({ ...scope, status: 'pending' }); } catch (e) { return 0; }
    }),
    now: (deps && deps.now) || new Date(),
  };
}
async function build(scope, deps) {
  const { outcomeService, Enrollment, Drive, Assessment, pendingRostersCount, now } = models(deps);
  const out = await outcomeService.institutionOutcomes(scope, deps);
  const labelByCohort = {}; for (const c of (out.cohorts || [])) labelByCohort[String(c.cohortId)] = c.label;
  const [invited, registered, diagnosticDone, active] = await Promise.all([
    Enrollment.countDocuments({ ...scope, status: 'invited' }),
    Enrollment.countDocuments({ ...scope, status: 'registered' }),
    Enrollment.countDocuments({ ...scope, status: 'diagnostic_done' }),
    Enrollment.countDocuments({ ...scope, status: 'active' }),
  ]);
  const funnel = { invited, registered, diagnosticDone, active, placed: (out.institution && out.institution.placedCount) || 0 };
  const dq = Drive.find({ ...scope });
  const allDrives = typeof dq.lean === 'function' ? await dq.lean() : await dq;
  const future = allDrives.filter((d) => d.driveDate && new Date(d.driveDate) >= now)
    .sort((a, b) => new Date(a.driveDate) - new Date(b.driveDate));
  const upcomingDrives = future.slice(0, 6).map((d) => ({ _id: d._id, name: d.name, role: d.role, package: d.package, driveDate: d.driveDate, status: d.status, cohortLabel: labelByCohort[String(d.cohortId)] }));
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const drivesThisWeek = future.filter((d) => new Date(d.driveDate) - now <= weekMs).length;
  const configuredAssessments = await Assessment.countDocuments({ ...scope, status: 'configured' });
  const pendingRosters = await pendingRostersCount(scope);
  return { outcomes: out.institution, funnel, upcomingDrives, attention: { configuredAssessments, pendingRosters, drivesThisWeek } };
}
module.exports = { build };
```
(Confirm the pending-roster model/field — read `src/models/RosterUpload.js` (or whatever the roster-upload model is) for the exact name + the `pending` status value, and adjust `pendingRostersCount`. If unsure, default it to 0 with a try/catch as shown.)

- [ ] **Step 5: Implement the route** `src/routes/institution/dashboard.js` (mirror `outcomes.js`; `router._deps`, `getService`, `institutionAuth`, `institutionScope`; GET any role):
```js
'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope } = require('../../middleware/institutionScope');
const router = express.Router();
router._deps = null;
function getService(deps) { return (deps && deps.dashboardService) || require('../../services/institution/dashboardService'); }
router.get('/dashboard', institutionAuth, async (req, res) => {
  try { const data = await getService(router._deps).build(institutionScope(req));
    return res.status(200).json({ success: true, data });
  } catch (err) { console.error('[institution/dashboard]', err.message); return res.status(500).json({ success: false, message: 'Could not load dashboard.' }); }
});
module.exports = router;
```
Mount in `src/routes/institution/index.js`: `router.use('/', require('./dashboard'));`.

- [ ] **Step 6: Run → PASS (2).** Then full suite `node --test src/test/institution/*.test.js` green.

- [ ] **Step 7: Commit + push.** `git add src/services/institution/dashboardService.js src/routes/institution/dashboard.js src/routes/institution/index.js src/test/institution/dashboard.route.test.js && git commit -m "TPO dashboard: aggregate endpoint (outcomes + funnel + upcoming drives + attention)" && git push origin master`

---

## Task 2: Web — command-center dashboard

**Files:** Modify `lib/institutionClient.ts` (add `dashboard()` + types); Modify `app/org/dashboard/page.tsx`.

**Interfaces:** `institutionApi.dashboard()` → `{ success, data: DashboardData }` (types per the contract).

- [ ] **Step 1: Add the client method + types** to `lib/institutionClient.ts` (`DashboardData`, `DriveLite`; `dashboard: () => req('GET', '/dashboard')`).

- [ ] **Step 2: Rebuild `app/org/dashboard/page.tsx`** as the cockpit using `_ui`:
  - `PageHeader` ("Dashboard", subtitle = institution name).
  - **Hero stat band:** `StatCard`s — Placement % (big), Highest package (LPA), Average package, Companies visited, Active students. From `data.outcomes` + `data.funnel`.
  - **Funnel:** a simple horizontal funnel/bar row — Invited → Registered → Diagnostic done → Active → Placed (values from `data.funnel`), each a labeled bar proportional to the max. (Use plain divs + tokens; no chart lib.)
  - **Upcoming drives:** a `DataTable` or card list of `data.upcomingDrives` (name, role·package, date, status `Badge`, cohort), with an `EmptyState` ("No upcoming drives — add recruiters on a cohort's page.").
  - **Needs your attention:** a card listing `data.attention` items that are > 0 as actionable rows that link to the right place — e.g. "{n} rosters awaiting approval" → `/org/approvals`, "{n} assessments configured but not released" → `/org/assessments`, "{n} drives this week" → (scroll to the drives section or `/org/outcomes`). If all zero, a calm "You're all caught up" state.
  - Keep the existing seats/role info if present, demoted to a small footer or the Settings page. Loading + error states via the kit.

- [ ] **Step 3: Build-verify.** `cd "/Users/nirpekshnandan/My Products/scaleup-web" && npx next build 2>&1 | grep -iE "error|Compiled successfully" | head` → "Compiled successfully".

- [ ] **Step 4: Deploy + commit.**
```
SRC="/Users/nirpekshnandan/My Products/scaleup-web"; rm -rf /tmp/sw-deploy && rsync -a --exclude=.git --exclude=node_modules --exclude=.next "$SRC/" /tmp/sw-deploy/ && cd /tmp/sw-deploy && npx vercel --prod --yes 2>&1 | grep -iE "Production|Aliased" | head
cd "$SRC" && git add lib/institutionClient.ts app/org/dashboard/page.tsx && git commit -m "TPO portal: command-center dashboard (placement %, funnel, upcoming drives, attention)"
```

---

## Final steps

- [ ] Confirm box on the new backend commit + pm2 online.
- [ ] Report: the dashboard is now a cockpit. W4 (staged cohort workspace) is next.

## Self-Review notes (addressed)

- **Spec coverage:** Part 4 (Dashboard) covered — aggregate endpoint (T1) + cockpit UI (T2).
- **Deterministic tests:** `now` is injected so upcoming/this-week filtering is testable; the assembly test asserts funnel, future-only sorted drives, cohortLabel join, and attention counts.
- **Reuse:** consumes `outcomeService.institutionOutcomes` (W2) for placement/package + funnel `placed`; no duplicate math.
- **Read-only + scoped:** GET any role, institution-scoped; no writes.
