# TPO Portal W4 — Staged Cohort Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the one-giant-scroll cohort page into a **staged workspace** — a `ProgressTracker` + tabs (Overview · Roster · Objective · Season & Companies · Assessments · Results · Outcomes · Content) where each stage shows status and the next action — so a TPO always knows where they are and what to do next.

**Architecture:** Web-only refactor of `app/org/cohorts/[cohortId]/page.tsx`. ALL existing sections/state/handlers are preserved and **moved** into stage tabs (no logic change); a `ProgressTracker` derives stage status from already-loaded data; an Overview tab adds a setup checklist; an Outcomes tab embeds the W2 cohort outcomes. No backend; reuses every existing institution API + the W2 outcomes endpoints.

**Tech Stack:** Next.js/React/TS using `app/org/_ui.tsx` (`Tabs`, `ProgressTracker`, `PageHeader`, `StatCard`, `DataTable`, `Badge`, `EmptyState`, `Card`, `Modal`).

## Global Constraints

- **Zero D2C impact; portal-only.** Only `app/org/cohorts/[cohortId]/page.tsx` (and `_ui.tsx` only if a component needs a prop). No backend.
- **PRESERVE EVERY EXISTING FEATURE.** This is a reorganization, not a rewrite: every data fetch, state variable, handler (`onClick`/submit), API call, route, and section that exists today must remain and keep working — just relocated into a stage tab. Do NOT drop the roster import/validate/approve flow, the season editor, the companies/drives CRUD, the objective attach, the notices composer, the curated-shelves manager, the performance trends, or the students table.
- **Deploy:** git-less Vercel; commit to the web repo.
- **Build clean:** `npx next build` → "Compiled successfully".

## Section → Stage map (move, don't delete)

The current page (read it fully first) has these sections; relocate each into the named tab:
| Current section | → Tab |
|---|---|
| Header (label/year/status/dept) | stays as `PageHeader` (breadcrumb ← Cohorts) above the tabs |
| Placement funnel (invited/registered/diagnosticDone/active StatTiles) | **Overview** |
| (new) setup checklist | **Overview** |
| Import students (paste/upload/validate/approve) + Students table | **Roster** |
| Cohort objective (attach template) | **Objective** |
| Placement season (dates) + Companies & Drives (combined) | **Season & Companies** |
| (new, lightweight) cohort assessments | **Assessments** |
| Performance over time (trends) | **Results** |
| (new) embed W2 cohort outcomes (offers + summary) | **Outcomes** |
| Notices + Curated shelves | **Content** |

`ProgressTracker` steps (with derived status done/current/upcoming): **Roster → Objective → Season → Assessments → Results → Outcomes**.

---

## Task 1: Restructure the cohort page into the workspace

**Files:** Modify `app/org/cohorts/[cohortId]/page.tsx`. (Add to `lib/institutionClient.ts` only if the Assessments tab needs a "list assessments for cohort" call that doesn't already exist — check first; the assessments list may already be filterable.)

**Interfaces:** Consumes `app/org/_ui.tsx` (`Tabs`, `ProgressTracker`, `StatCard`, `DataTable`, `Badge`, `EmptyState`) + the W2 client methods (`listOffers`, `cohortOutcomes`, `createOffer`, `importOffers`, etc.) for the Outcomes tab.

- [ ] **Step 1: Read the whole current page** and inventory every state variable, loader (`useEffect`/`load*`), handler, and section. Make a list so nothing is lost.

- [ ] **Step 2: Add the workspace scaffold.** Keep the existing data loading + all state at the top of the component unchanged. Replace the long body's section stack with: a `PageHeader` (cohort label + year/status badges + breadcrumb), a `ProgressTracker` (the 6 steps; derive each step's status from loaded data — see Step 4), and a `Tabs` control with the 8 tabs. Render the active tab's content from the relocated sections. Use a `tab` state (default 'overview'); optionally sync to a `?tab=` query param.

- [ ] **Step 3: Move each section into its tab — VERBATIM logic.** Cut each existing section's JSX into the matching tab's render, keeping its surrounding state + handlers intact. Re-skin lightly with the kit where trivial (StatTiles → `StatCard`, status text → `Badge`, blank empties → `EmptyState`) but do NOT change any handler or data flow. The Roster, Objective, Season & Companies, Notices, Shelves, Trends, and Students sections all move unchanged.

- [ ] **Step 4: Derive stage status + Overview checklist.** Compute booleans from already-loaded data: `hasRoster` (students.length > 0 or funnel.registered+invited > 0), `hasObjective` (cohort.objectiveTemplateId), `hasSeason` (cohort.placementSeason?.startDate || endDate || drives.length > 0), `hasAssessments` (cohort assessment count > 0), `hasResults` (trends?.length > 0), `hasOutcomes` (offers.length > 0). Feed these into `ProgressTracker` (done = true) and into an **Overview setup checklist** (each item: label, done/✓ or a "Do this" link to its tab). The current step = the first not-done.

- [ ] **Step 5: Build the Assessments tab.** Lightweight: show the count of this cohort's assessments + a "Manage assessments" button → `/org/assessments` (the existing assessments page; if it supports a cohort filter via query, link with it). If a "list assessments for this cohort" client method already exists, show them in a `DataTable` (title, type, status `Badge`, link to the assessment detail). Do NOT rebuild assessment creation here.

- [ ] **Step 6: Build the Outcomes tab.** Embed the W2 cohort outcomes for THIS cohort: call `cohortOutcomes(cohortId)` + `listOffers(cohortId)`; render the summary `StatCard`s (placement %, highest/avg/median LPA, companies) + branch-wise list + the offers `DataTable` with the "Add offer" `Modal` + bulk import (reuse the same UI approach as `/org/outcomes`, scoped to this cohort). Manager-gated writes. (If cleaner, extract a shared `<CohortOutcomes cohortId>` component used by both `/org/outcomes` and this tab.)

- [ ] **Step 7: Build-verify.** `cd "/Users/nirpekshnandan/My Products/scaleup-web" && npx next build 2>&1 | grep -iE "error|Compiled successfully" | head` → "Compiled successfully".

- [ ] **Step 8: Self-check — nothing lost.** Compare your Step-1 inventory against the result: every loader, state, handler, and section is present and wired. Confirm the roster approve, season save, drive/notice/shelf CRUD, and objective attach all still call their original handlers.

- [ ] **Step 9: Deploy + commit.**
```
SRC="/Users/nirpekshnandan/My Products/scaleup-web"; rm -rf /tmp/sw-deploy && rsync -a --exclude=.git --exclude=node_modules --exclude=.next "$SRC/" /tmp/sw-deploy/ && cd /tmp/sw-deploy && npx vercel --prod --yes 2>&1 | grep -iE "Production|Aliased" | head
cd "$SRC" && git add -A && git commit -m "TPO portal: staged cohort workspace (progress tracker + tabbed stages + outcomes)"
```

---

## Final steps

- [ ] Manually verify each tab loads and every preserved action works (roster validate/approve, season save, add/edit/delete drive, add/edit/delete notice, add shelf + item, attach objective, add offer).
- [ ] Report: the cohort page is now a guided workspace; W5 (Tier 3) is the last phase.

## Self-Review notes (addressed)

- **Spec coverage:** Part 5 (staged cohort workspace) covered — ProgressTracker + 8 tabs + setup checklist + the Outcomes stage embedding W2.
- **Risk control:** the dominant risk is dropping a handler during the move; Steps 1 + 8 bracket the work with an explicit inventory/verify, and the plan mandates verbatim handler/data preservation. A behavior-preservation review (like W1's) should run after.
- **No backend:** reuses all existing endpoints + W2 outcomes; the Assessments tab links to the existing page rather than rebuilding creation.
- **DRY:** the cohort Outcomes tab should reuse a shared component with `/org/outcomes` rather than copy the offers UI.
