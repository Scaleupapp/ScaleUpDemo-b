# TPO Portal W1 — Design System + Sidebar Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bland top-nav portal chrome with a credible, data-forward **sidebar app shell** and a real **design-system component library**, then migrate the existing `/org` pages onto it — same features, dramatically better presentation and a clear "where am I / where next" structure.

**Architecture:** A new self-contained UI module (`app/org/_ui.tsx`) extends the existing `_components.tsx` primitives into a full kit (Shell, Sidebar, PageHeader, StatCard, DataTable, Badge, Tabs, ProgressTracker, EmptyState, Toolbar, Modal). `app/org/layout.tsx` swaps the top nav for `Shell` (sidebar + topbar + content). Existing pages are re-skinned to use `PageHeader` + the new components. No backend, no feature/behavior changes, no new routes in W1.

**Tech Stack:** Next.js App Router (client components), React, TypeScript, Tailwind, the existing `ORG` light palette. Verify with `npx next build`.

## Global Constraints

- **Zero D2C impact; portal-only.** Never import the dark global theme. Keep the `_components`/`_ui` modules self-contained (same invariant as today). No changes outside `app/org/**` and (if needed) `lib/institutionClient.ts` types.
- **No feature changes in W1.** Every page keeps its current data, actions, and routes — only the chrome/components/layout change. (Cohort-page restructure into stages is W4, NOT here.)
- **Reuse `ORG` tokens** (bg `#F3F5F7`, card `#FFFFFF`, ink `#0F1B24`, ink2 `#566570`, ink3 `#8B99A4`, line `#E5E9ED`, teal `#0C5C68` primary, gold `#A9790C`, good green, warn red). Add only derived scale (spacing/radius/elevation/status) — no new brand hues.
- **Design language:** sidebar IA; generous whitespace with clear hierarchy; hero numbers in a confident display weight; teal = primary action, gold = accent/upcoming, green = positive/placed, grey = muted/closed; real empty states with a directive + CTA; sentence-case, end-user copy.
- **Quality floor:** responsive (sidebar collapses under ~1024px to a top bar or drawer), visible keyboard focus, accessible contrast.
- **Deploy:** git-less Vercel (`rsync … && vercel --prod`); commit to the web repo.

---

## File Structure

- Create `app/org/_ui.tsx` — the new component kit (imports/re-exports `ORG` + may re-export the still-good primitives from `_components.tsx`).
- Modify `app/org/layout.tsx` — swap top nav → `Shell` (sidebar).
- Modify each page under `app/org/**/page.tsx` — wrap content in `PageHeader` + adopt `StatCard`/`DataTable`/`Badge`/`EmptyState` where they currently use ad-hoc markup. Keep all logic/state/handlers.
- `app/org/_components.tsx` — keep; `_ui.tsx` builds on it. Upgrade `Card`/`Chip` only if needed (non-breaking).

---

## Task 1: Design-system kit + sidebar Shell + layout swap

**Files:** Create `app/org/_ui.tsx`; Modify `app/org/layout.tsx`.

**Interfaces (Produces):** the components below, all token-driven and self-contained:
- `Shell({ children })` — fixed left **Sidebar** (institution name/logo, nav groups, user+role footer, sign out) + a content area; responsive (collapses to a top bar + drawer under ~1024px). Nav items (icon + label, active state): Dashboard, Cohorts, Drives, Outcomes, Assessments, Library, Notices, Approvals (role-gated), Team, Settings. (Routes that don't exist yet — Drives/Outcomes/Library/Notices/Settings — render as nav items pointing at their eventual paths; if a target page doesn't exist yet, point them at the nearest existing page or a lightweight "coming in a later phase" placeholder using `NotAvailable`. Do NOT build those features here.)
- `PageHeader({ title, subtitle?, actions?, breadcrumb? })`.
- `StatCard({ label, value, sub?, tone? })` — big display value + label + optional sublabel/delta; tones map to status colors.
- `DataTable({ columns, rows, empty })` — sortable header optional, zebra/hover rows, built-in `EmptyState` when no rows, optional row actions.
- `Badge({ label, tone })` / keep `Chip` — tones: placed/green, active/teal, upcoming/gold, closed/grey, risk/amber, neutral.
- `Tabs({ tabs, active, onChange })`.
- `ProgressTracker({ steps, current })` — horizontal stepper with done/current/upcoming states (used by W4; build the component now).
- `EmptyState({ icon?, title, message, action? })`.
- `Toolbar` (filter/search/actions row), `Modal({ open, title, children, onClose })`.

- [ ] **Step 1: Build `_ui.tsx`.** Implement all components above using `ORG` tokens + Tailwind, self-contained, typed. Keep each component small + focused. Re-export the primitives still in use from `_components.tsx` (`Card`, `Btn`, `Field`, `Spinner`, `inputCls`, `inputStyle`) so pages can import everything from `_ui`.

- [ ] **Step 2: Swap the layout to `Shell`.** In `app/org/layout.tsx`, replace the top-nav markup with `<Shell>{children}</Shell>`. Preserve the existing auth/role gating + sign-out + the role-based nav visibility (Approvals gated). Read the current layout first and keep its auth behavior intact.

- [ ] **Step 3: Build-verify.** `cd "/Users/nirpekshnandan/My Products/scaleup-web" && npx next build 2>&1 | grep -iE "error|Compiled successfully" | head` → "Compiled successfully".

- [ ] **Step 4: Commit.** `cd "/Users/nirpekshnandan/My Products/scaleup-web" && git add app/org/_ui.tsx app/org/layout.tsx && git commit -m "TPO portal: design-system kit + sidebar app shell"`

---

## Task 2: Migrate existing pages onto the shell

**Files:** Modify `app/org/dashboard/page.tsx`, `cohorts/page.tsx`, `cohorts/[cohortId]/page.tsx`, `assessments/page.tsx`, `assessments/[id]/page.tsx`, `objectives/page.tsx`, `departments/page.tsx`, `team/page.tsx`, `approvals/page.tsx`, `analytics/page.tsx`.

**Interfaces (Consumes):** the `_ui` kit from Task 1.

**Goal:** Each page renders inside the shell with a `PageHeader` (title/subtitle/primary action) and adopts `StatCard`/`DataTable`/`Badge`/`EmptyState`/`Toolbar` where it currently uses ad-hoc stat tiles, tables, status text, or blank empty states. **No feature, data, route, or handler changes** — purely presentational migration. The cohort page is NOT restructured into stages here (that's W4); just re-skin its current sections with the new components and a `PageHeader`.

- [ ] **Step 1: Migrate the list/index pages** (dashboard, cohorts, departments, team, objectives, assessments, approvals, analytics): wrap in `PageHeader`; convert stat rows → `StatCard`s; convert tables/lists → `DataTable` with real `EmptyState`s; status text → `Badge`. Keep every existing action button + handler.

- [ ] **Step 2: Migrate the detail pages** (`cohorts/[cohortId]`, `assessments/[id]`): add a `PageHeader` with breadcrumb (← Cohorts / ← Assessments) and re-skin the existing section cards with the kit. Do NOT change the cohort page's section set or behavior (W4 restructures it). Keep the existing Companies/Notices/Shelves/Season sections working as-is, just restyled via the kit's `Card`/`SectionLabel`/`Badge`/`EmptyState`.

- [ ] **Step 3: Build-verify.** `cd "/Users/nirpekshnandan/My Products/scaleup-web" && npx next build 2>&1 | grep -iE "error|Compiled successfully" | head` → "Compiled successfully".

- [ ] **Step 4: Deploy + commit.**
```
SRC="/Users/nirpekshnandan/My Products/scaleup-web"; rm -rf /tmp/sw-deploy && rsync -a --exclude=.git --exclude=node_modules --exclude=.next "$SRC/" /tmp/sw-deploy/ && cd /tmp/sw-deploy && npx vercel --prod --yes 2>&1 | grep -iE "Production|Aliased" | head
cd "$SRC" && git add -A && git commit -m "TPO portal: migrate pages onto the new shell + design system"
```

---

## Final steps (after both tasks)

- [ ] Confirm the deployed portal at placement.scaleupapp.club loads, the sidebar nav works, role-gating (Approvals) is intact, and every existing action still functions (no behavior regressions).
- [ ] Report: the portal now has a sidebar IA + design system; W2 (Placement Outcomes) is next.

## Self-Review notes (addressed)

- **Spec coverage:** Parts 1 (IA/shell) + 2 (design system) of the spec are covered. New-feature surfaces (Outcomes/Dashboard cockpit/Drives/cohort-stages) are later phases; W1 only adds nav entries pointing at them (placeholder where the page doesn't exist), no feature build.
- **No behavior change:** Task 2 is explicitly presentational; all handlers/data/routes preserved. The cohort page keeps its current sections (W4 restructures).
- **Self-contained styling:** `_ui.tsx` uses only `ORG` tokens + Tailwind, never the dark theme — preserving the portal invariant.
- **Component reuse:** `ProgressTracker`/`Tabs`/`DataTable` are built now even though W4 leans on them, so the workspace phase consumes a ready kit.
