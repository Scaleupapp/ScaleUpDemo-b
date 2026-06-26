# Placement Practice + UX Uplift — Design Spec

**Date:** 2026-06-26
**Status:** Approved (design); pending implementation plans
**Goal:** Give placement students a private, performance-driven **Practice** experience (reps using the same engines as assessments, recommended from their weak areas), and uplift the visual/UX quality of the placement screens (Campus, Library, Home, Results) which currently read as sparse scaffolding.

## Context

The placement student app (iOS Swift `ScaleUpDemo-f`, RN `ScaleUpAndroid`) reached feature-complete across 4 phases (lean You tab, Companies/Drives, Notices, Shelves) but: (1) we stripped the **broken D2C "Practice it now"** without replacing it, so students can only practice Quiz + Mock-interview (via Compass) and have no guidance on *what* to practice; and (2) the new placement screens (Campus "Drives & notices", Library "Placement prep") are flat single-item lists with large empty voids and weak hierarchy. The TPO assessment results already carry a **competency breakdown** we can drive recommendations from. The four engines (quiz/drill/capstone/interview) already support private, self-initiated sessions in the consumer app.

## Decisions (locked with user)

- **Practice is private & non-graded.** Never shown to the TPO; does not affect official readiness/assessment scores. Only TPO-assigned assessments stay graded + TPO-visible.
- **Surface:** Recommendations on the **result screen** + **Home**, plus a **Practice hub** screen reached from Home (NOT a new bottom tab).
- **Engines:** all four — Quiz (MCQ), Coding drill, Capstone, Mock interview.
- **UX uplift scope:** Campus, Library, Home, Result screens (You tab already leaned).

## Global Constraints

- **Zero D2C impact.** New endpoint is cohort/enrollment-scoped behind placement auth; all app changes gated to the placement shell. No D2C model/route changes; the D2C engine flows are *reused*, not modified.
- **Practice must NOT create an institution `AssessmentSession`.** Practice uses the existing D2C self-practice paths (Quiz/QuizAttempt, InterviewSession, DrillAttempt, CapstoneSession), which are already private and not institution-graded. The graded path (`/me/assessments/:id/start` → AssessmentSession) is untouched and remains the only TPO-visible one.
- **Both apps** (iOS + RN) for every student-facing change.
- **Reuse, not rebuild:** practice launches the existing engine flows/home views; the only new backend is the recommendation endpoint.

---

## Part 1 — Placement Practice

### 1A. Recommendation endpoint (backend)

`GET /api/v2/me/placement/practice` → `{ success, data: { hasAssessment: bool, recommendations: Recommendation[], types: PracticeType[] } }`

- Resolve the student's most recent **graded** `AssessmentSession`(s) for their enrolled cohort(s).
- Extract per-competency scores from `result.raw` (MCQ → `competencyBreakdown`; interview/capstone → `dimensions`/`dimension_scores`; drill → `rubric_breakdown`). Normalize to `{ name, score }`.
- Pick the **2–3 weakest** competencies (lowest score). For each, build a `Recommendation`:
  `{ competency: string, score: number, suggestedType: 'quiz'|'drill'|'capstone'|'interview', topic: string, reason: string }`.
  Mapping: a weak competency → a **quiz** on that competency `topic` by default (quiz is the fast, universally-applicable rep); plus one generic **interview** or **drill** suggestion tied to the objective/role when relevant. Keep the mapping simple and deterministic (documented in the plan).
- `types` = the four practice types (so the hub renders "start any" even with no assessment yet).
- `hasAssessment=false` when the student has no graded assessment → empty recommendations; the hub still offers free practice.
- Tests: weakest-competency selection, empty-without-assessment, scoping by enrollment.

**No new "practice session" model.** Practice sessions are the existing engine sessions, launched from the app.

### 1B. Practice hub + entry points (apps)

- **`PlacementsPracticeApi`** (iOS) / **`practiceApi.ts`** (RN): `fetchPractice()` → the endpoint above.
- **Practice screen** (new, reached from Home): renders (i) **Recommended for you** — the recommendations as cards ("Project Tracking · 30% → Practice quiz", tap launches the engine pre-seeded with the topic); (ii) **Practice any time** — the four engine types as cards, each launching the corresponding existing engine flow. A short header explains practice is private and ungraded.
- **Launch reuses existing flows:** Quiz + Interview already launch via Compass/engine home views; Drill + Capstone via the existing coding hub/engine entry. The Practice screen presents/navigates to these (with a topic where the engine supports it). No new engine code.
- **Home:** a **Practice** card/section (after the scheduled-assessments card) showing the top recommendation + a "Practice" button → the Practice screen.
- **Result screen:** after an assessment, a **"Recommended practice"** block with 1–2 CTAs launching the engine for the weakest competency (this fills the current empty space below the score, and is shown regardless of window-closed since practice is always allowed).

---

## Part 2 — Visual / UX Uplift

### Design language (applied consistently, iOS + RN)

- **Cards:** a single elevated-surface card style with clear **title → meta → body** hierarchy; consistent corner radius, padding, and divider treatment. No more flat full-width voids.
- **Accent:** the gold brand accent used **purposefully** (primary actions, key numbers, active states) — not as the default text color.
- **Status & type color:** consistent status pills (drive open/closed/upcoming/visited; notice pinned/unread) and item-type glyphs (file/link, quiz/drill/capstone/interview).
- **Empty states:** every list has a real empty state with a one-line "what goes here / what to do" rather than blank space.
- **Density:** group related content; reduce dead vertical space; use section headers consistently.

### Per-screen

- **Campus ("Drives & notices"):** drive cards get a **company avatar/initial chip**, prominent **role · package**, status pill, a **bookmark star** (folds in the already-built bookmark backend — toggles `POST/DELETE /me/placement/companies/:id/bookmark`, reads `bookmarked`), and an **"in N days"** countdown to the drive date; notice cards get pinned/unread treatment + clearer hierarchy. Real empty states for both sections.
- **Library ("Placement prep"):** shelf cards show an **item count**, item rows use type glyphs (file/link) with cleaner alignment + the note as secondary text; restyle the "Ask Compass" card as a subtle helper, not a primary card.
- **Home:** tighten the readiness ring / objective / placement-season / assessments cards into the shared card language; add the **Practice section + top recommendation**; ensure the objective name renders well.
- **Results:** polish the score hero + competency/dimension breakdown; add the **practice recommendation** CTA block; keep the gated per-question review (post-close) intact.

---

## Phasing (each its own plan + subagent build)

1. **Phase A — Practice feature:** recommendation endpoint (TDD) → Practice hub + Home/result entry points → wire the four engine launches. Both apps. (Adds the substance.)
2. **Phase B — Visual uplift:** the design-language pass on Campus, Library, Home, Results + the bookmark star. Both apps. (The craft; incorporates the Practice surfaces from Phase A.)

## Data flow

```
TPO assessment graded → AssessmentSession.result.raw (competency breakdown, already stored)
Student app → GET /me/placement/practice → weak competencies → recommendations
Student taps a recommendation/type → existing engine flow (private Quiz/Drill/Capstone/Interview) → existing engine result (practice-appropriate)
   (never creates an AssessmentSession; never visible to TPO)
```

## Testing

- **Backend:** recommendation selection (weakest-first), empty-without-assessment, enrollment scoping — `node:test` + DI stubs.
- **Apps:** compile/tsc; manual pass that practice launches each engine and never appears in the TPO portal.
- **D2C regression:** the consumer engine flows and result screens are unchanged (practice reuses them as-is).

## Out of scope (explicit)

- Push/scheduled practice reminders.
- A separate Practice bottom tab (kept to Home entry).
- TPO visibility into practice (explicitly private).
- New engines or changes to engine grading.
- Drive bookmark *reminders* (bookmark UI lands in Phase B; reminders deferred — chosen timing when built: 1 day before + morning of).
