# TPO Portal — Platform Redesign + Placement Outcomes Design Spec

**Date:** 2026-06-27
**Status:** Approved (design); pending per-phase implementation plans
**Goal:** Turn the TPO web portal (`scaleup-web`, `/org`) from a pile of default-styled forms into a credible, workflow-guided placement-management platform: a real design system + sidebar IA, a command-center dashboard, a staged cohort workspace, and the completeness feature Indian colleges live on — **placement outcomes** (offers → placement % + package stats) — plus a drive pipeline, cohort analytics, and exportable reports.

## Context

`scaleup-web/app/org` is a Next.js (App Router, client components) portal with a **top nav** (Dashboard / Departments / Cohorts / Objectives / Assessments / Approvals / Team / Analytics) and a `app/org/_components.tsx` primitive set (`Card`, `Btn` [solid|outline], `Field`, `Chip`, `StatTile`, `SectionLabel`, `Spinner`, `inputCls`/`inputStyle`, `ORG` light palette: bg `#F3F5F7`, card white, ink `#0F1B24`, teal `#0C5C68`, gold `#A9790C`, good green, warn red). The cohort detail page (`app/org/cohorts/[cohortId]/page.tsx`) stacks *everything* (funnel, objective, placement season + companies, trends, students, roster import, notices, shelves) on one long scroll. API client: `lib/institutionClient.ts`. Backend institution routes under `/api/institution` (org, assessments, rosters, objectiveTemplates, notices, shelves, uploads).

**Problems:** (1) the portal is form-stacks, not a workflow — a TPO can't tell what stage a cohort is in or what to do next; (2) it's visually bland/un-credible for a buyer-facing surface; (3) it measures *prep readiness* but never *placements* — the placement cell's actual job.

## Decisions (locked with user)

- Build **everything** (Tiers 1–3): Placement Outcomes, command-center Dashboard, staged cohort workspace, design system, drive pipeline, cohort analytics, exportable reports.
- **New design system + restructured IA** (sidebar shell), not just a re-skin.
- Web-only (the student apps are done). Reuse existing institution APIs; add Outcomes/pipeline/report endpoints.

## Global Constraints

- **Zero D2C impact.** Portal + institution backend only. New backend is additive, scoped by `institutionScope` (institutionId from token) and role-gated like the existing institution routes.
- **Reuse the deploy path:** web ships via the git-less Vercel trick (`rsync … && vercel --prod`); backend via push to `master`.
- **Self-contained portal styling** (the `_components` set never imports the dark global theme — keep that invariant).
- **Backend tests** for new endpoints: `node:test` + `supertest` + `router._deps` DI stubs (no DB), mirroring the existing institution route tests; scope-isolation + role-gating asserted.

---

## Part 1 — Information Architecture (sidebar shell)

Replace the top nav with a **left sidebar** app shell grouped by how a TPO works:
- **Dashboard** — command center (institution-wide).
- **Cohorts** — list → each opens a **staged workspace** (tabs/stages).
- **Drives** — cross-cohort recruiting + pipeline.
- **Outcomes** — offers & placement stats (institution + per cohort).
- **Assessments** — existing, re-skinned.
- **Library** / **Notices** — existing content tools (today nested in the cohort page; also surface here).
- **Team**, **Settings** (institution profile, branding), **Approvals** (roster approvals, role-gated).

The sidebar shows the institution name/logo, the signed-in user + role, and collapses on small screens. Active-state + section grouping make "where am I / where next" obvious.

## Part 2 — Design System (distinctive, credible B2B)

A **light, data-forward** identity carrying the ScaleUp brand. Extend `_components.tsx` into a real component library (or a `app/org/_ui/` module):
- **Primitives:** `Shell` (sidebar + topbar + content), `PageHeader` (title + subtitle + actions + breadcrumb), `Card`, `StatCard` (label, big value, delta/sublabel, optional spark), `DataTable` (sortable, empty state, row actions), `Badge`/`Pill` (status), `Tabs`, `ProgressTracker` (stage stepper), `EmptyState` (icon + directive copy + CTA), `Modal`, `Drawer`, `Field` set, `Toolbar`, `Toast`.
- **Tokens:** keep the existing `ORG` palette as the base; add a small scale for elevation, spacing, radius, and a status set (placed/green, in-progress/teal, upcoming/gold, closed/grey, risk/amber). Type scale with a confident display weight for hero numbers (package, placement %).
- **Signature:** the **placement story** rendered with craft — a **funnel** (invited → registered → ready → placed), a **readiness band**, and **hero stats** (placement %, highest/avg package) — not generic stat tiles. This is the memorable, buyer-convincing element.
- **Copy:** sentence case, end-user framed, real empty states that say what appears and the next action.

## Part 3 — Placement Outcomes (the completeness feature)

**New model `PlacementOffer`** (`src/models/PlacementOffer.js`):
```
{ institutionId, cohortId, enrollmentId?, studentUserId?, studentName, rollNumber?,
  companyName, driveId?(ref PlacementDrive), role, ctc (Number, LPA), offerType ('full_time'|'internship'),
  status ('offered'|'accepted'|'joined'|'declined'), offerDate, notes, createdBy, timestamps }
```
**Endpoints (TPO, institution-scoped, role-gated admin/tpo_head/tpo_coordinator for writes):**
- `POST/GET/PATCH/DELETE /api/institution/cohorts/:cohortId/offers` — CRUD.
- `POST /api/institution/cohorts/:cohortId/offers/import` — bulk CSV (mirror the roster import validation pattern).
- `GET /api/institution/cohorts/:cohortId/outcomes` — summary: **placement % (distinct students with accepted/joined ÷ cohort size), highest/average/median CTC, companies-visited count, branch-wise placed counts** (join enrollment.departmentId), offer-status counts.
- `GET /api/institution/outcomes` — institution-wide rollup across cohorts (for the dashboard).
**Web:** an **Outcomes** section (institution page + a stage in the cohort workspace) — record/import offers, the hero stats, branch-wise + package-band charts, the placed-students table.

## Part 4 — Command-center Dashboard

`/org/dashboard` becomes the cockpit (institution-wide): **placement % + package hero stats** (from Outcomes), the **funnel**, **upcoming drives this week** (from PlacementDrive), **cohort readiness distribution** (from existing CohortRollup/assessment data), and a **"Needs your attention"** action list (pending roster approvals, configured-but-unreleased assessments, graded-but-unreviewed results, drives this week). Each item links to the exact place to act.

## Part 5 — Staged Cohort Workspace

`/org/cohorts/[cohortId]` becomes a **workspace** with a `ProgressTracker` + tabbed stages, each showing status + next action:
1. **Overview** — funnel + this-cohort stats + checklist.
2. **Roster** — import/approve students, the student table.
3. **Objective** — attach/curate the objective template.
4. **Season & Companies** — dates + the drives list (already combined).
5. **Assessments** — the cohort's assessments (link to the assessments surface).
6. **Results** — per-assessment results + cohort analytics.
7. **Outcomes** — offers + placement stats for the cohort.
A **setup checklist** for a new cohort guides first-time TPOs (roster imported? objective set? season set? first assessment released?).

## Part 6 — Tier 3

- **Drive pipeline:** a per-drive lifecycle — **interested → applied → shortlisted → offered/rejected**. Backend `DriveApplication` (`{ driveId, studentUserId, stage, updatedBy, timestamps }`); the student **bookmark** (already built) seeds "interested". TPO moves students across stages on a drive board; an "offered" stage can create a `PlacementOffer`.
- **Cohort analytics:** cohort-wide competency aggregation (from `CohortRollup`) — strongest/weakest competencies, **at-risk students** (low readiness / missed assessments) — to drive group interventions.
- **Reports/export:** one-click **placement report** (CSV now; PDF later) — placement %, package bands, branch-wise, company list — the artifact colleges submit (NIRF) and market with.

## Phasing (each ships working software; own plan each)

1. **W1 — Design system + sidebar shell.** Build the component library + `Shell`/sidebar IA; migrate existing pages onto it (re-skin, no feature change). Foundation everything else uses.
2. **W2 — Placement Outcomes.** `PlacementOffer` model + endpoints (TDD) + the Outcomes UI (record/import offers, cohort outcomes summary).
3. **W3 — Command-center Dashboard.** The cockpit, now fed by outcomes + assessments + funnel + drives.
4. **W4 — Staged cohort workspace.** Restructure the cohort page into the tabbed stage workspace incl. the Outcomes stage + checklist.
5. **W5 — Tier 3.** Drive pipeline (`DriveApplication` + board), cohort analytics, report export.

## Data flow

```
Roster (exists) → enrollments → assessments → CohortRollup (readiness)        ┐
Drives (exists) + DriveApplication (W5) → pipeline                            ├─► Dashboard (W3) + Cohort workspace (W4)
PlacementOffer (W2) → outcomes summary (placement %, packages, branch-wise)   ┘
Reports (W5) export the above.
```

## Testing

- **Backend:** new route modules get `node:test` + DI-stub tests — scope isolation (institution A can't read B's offers/applications), role gates, the outcomes math (placement % = distinct accepted/joined ÷ cohort size; median/avg/highest CTC), bulk-import validation.
- **Web:** `npx next build` clean per phase; manual pass of each workspace stage; verify the portal still never imports the dark theme.

## Out of scope (explicit)

- Student-app changes (the apps are done; the drive pipeline reads the already-built bookmark).
- PDF report generation in W5 (CSV first; PDF a follow-on).
- Email/SMS comms (notices exist in-app).
- Public placement microsite.
