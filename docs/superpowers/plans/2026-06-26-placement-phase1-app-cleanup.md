# Placement Phase 1 — App Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip B2C-only surfaces from the placement student experience on both apps — a lean "You" tab, a placement-scoped Compass, and placement-clean immediate assessment results — with zero backend changes and zero D2C impact.

**Architecture:** Pure client-side gating on an existing placement signal. iOS reads placement state from `AppState`/the placement shell; RN reads `userContext.persona === 'placement'` from the Redux `selectUserContext`. Sections/options that don't apply to placement are hidden behind that flag. No new endpoints; existing payloads are unchanged.

**Tech Stack:** iOS — Swift / SwiftUI (`ScaleUpDemo-f`, xcodegen + xcodebuild, build number in `project.yml`). Android — React Native / TypeScript (`ScaleUpAndroid`, `tsc --noEmit`).

## Global Constraints

- **Zero D2C impact.** Every change is gated on a placement flag; the default (non-placement) path renders exactly as today. Verify the D2C path is untouched.
- **Both apps.** Modules 1–3 ship on iOS AND Android.
- **No backend changes** in this phase. No new endpoints, no model edits.
- **Verification = compilation.** These repos have no unit-test harness for UI gating; the test cycle is a clean compile (iOS `xcodebuild … build`, RN `npx tsc --noEmit`) plus the gated element being correctly conditional. Each task ends compiled-clean and committed.
- **iOS build number:** bump `CURRENT_PROJECT_VERSION` in `ScaleUpDemo-f/project.yml` only in the FINAL iOS task (Task 3), not per task, to avoid churn. Current = 202 → set 203.
- **Commit per task** on the repo's existing working branch (iOS `master`, RN `main`), matching the established manual-deploy workflow. Do not open PRs.

---

## File Structure

**iOS (`/Users/nirpekshnandan/My Products/ScaleUpDemo-f`):**
- `ScaleUp/Features/V2/You/V2YouView.swift` — add `isPlacement` param; gate 5 B2C sections.
- `ScaleUp/Features/V2/You/V2YouSections.swift` — the library-strip / hiring / creator section builders (gate at call sites in V2YouView).
- `ScaleUp/Features/Placements/Core/PlacementsMainTabView.swift` — pass `isPlacement: true` into `V2YouView` and into Compass.
- `ScaleUp/Features/V2/Compass/V2CompassView.swift` — quick-actions bar (lines ~667–680) + competition banner (header).
- `ScaleUp/Features/V2/Compass/CompassViewModel.swift` — default suggestions (~233–241) + competition fetch.
- `ScaleUp/Features/Placements/Assessments/PlacementInterviewTakeView.swift`, `PlacementDrillTakeView.swift`, `PlacementCapstonePairView.swift`, `PlacementsAssessmentsView.swift` — route engine completion to the placement result, not the B2C result.
- `project.yml` — build bump (Task 3).

**Android (`/Users/nirpekshnandan/My Products/ScaleUpAndroid`):**
- `src/features/v2/screens/V2YouScreen.tsx` — gate 5 B2C sections on existing `inPlacement` (line 99).
- `src/features/v2/screens/V2CompassScreen.tsx` — filter `COMPASS_QUICK_ACTIONS` (lines 160–172) + gate today's-challenge banner (lines 856–882) on placement.
- `src/features/placements/screens/PlacementsHomeScreen.tsx` — route engine completion to `PlacementResultView`, not the B2C result screens (`QuizResultsScreen`/`InterviewResultsScreen`).
- `src/store/slices/authSlice.ts` — `selectUserContext` (read-only; no change).

---

## Task 1: iOS — Lean placement "You" tab

**Files:**
- Modify: `ScaleUp/Features/V2/You/V2YouView.swift`
- Modify (call site): `ScaleUp/Features/Placements/Core/PlacementsMainTabView.swift` (the `V2YouView()` call, ~line 35)
- Reference: `ScaleUp/Features/V2/You/V2YouSections.swift`

**Interfaces:**
- Produces: `V2YouView(isPlacement: Bool = false)` — a new optional init parameter. Default `false` preserves the D2C call sites unchanged.

**Goal:** When `isPlacement == true`, hide these sections: (a) the "My Library" chip strip (Saved / Liked / Playlists / History), (b) followers/following counts in the header, (c) "Become a Creator" card + application-status card, (d) "Open to Opportunities" / hiring section, (e) Creator Hub section. Keep everything else (readiness ring, stats, My objective, My plan, Progress & analytics, Mock interviews, My notes, My Compass activity, Settings, footer).

- [ ] **Step 1: Add the init parameter.** In `V2YouView.swift`, add a stored property `let isPlacement: Bool` and ensure the memberwise/explicit init accepts `isPlacement: Bool = false`. If the struct relies on the synthesized init, add an explicit `init(isPlacement: Bool = false) { self.isPlacement = isPlacement }` (preserving any existing stored view-model/state initialization — read the current init first).

- [ ] **Step 2: Gate the 5 sections.** Wrap each of the five section builders in `if !isPlacement { … }` at their call sites in the `body` (the My Library chip strip; the followers/following row in the header block; the Become-a-Creator card; the application-status card; the Open-to-Opportunities/hiring block; the Creator Hub block). Read each section's current call site and wrap it; do not delete the section definitions (D2C still uses them).

- [ ] **Step 3: Pass the flag from the placement shell.** In `PlacementsMainTabView.swift`, change the You-tab content from `V2YouView()` to `V2YouView(isPlacement: true)`.

- [ ] **Step 4: Compile-verify.**

Run:
```
cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && /opt/homebrew/bin/xcodegen generate && xcodebuild -scheme ScaleUp -destination 'generic/platform=iOS' -configuration Debug build CODE_SIGNING_ALLOWED=NO -quiet 2>&1 | tail -30
```
Expected: `BUILD SUCCEEDED` (warnings allowed; no errors). Confirm the D2C call sites still compile (they use the defaulted `isPlacement: false`).

- [ ] **Step 5: Commit.**
```
cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && git add -A && git commit -m "Placement: lean You tab (hide B2C library/social/creator/hiring sections)"
```

---

## Task 2: iOS — Compass scoped for placement

**Files:**
- Modify: `ScaleUp/Features/V2/Compass/V2CompassView.swift`
- Modify: `ScaleUp/Features/V2/Compass/CompassViewModel.swift`
- Modify (call site): `ScaleUp/Features/Placements/Core/PlacementsMainTabView.swift` (Compass FAB/sheet presentation, ~line 42)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a placement signal reaching Compass. Add `isPlacement: Bool = false` to the Compass entry view (`V2CompassView` or the sheet wrapper presented by the FAB). Plumb it to the quick-actions list and competition banner.

**Goal:** When placement: the Compass quick-actions/suggestions show only **Quiz me, Practice interview, Explain something, Make a note**. Hide **Compete today**, **Coding capstone**, **Plan my days**, and suppress the "Today's challenge" competition banner.

- [ ] **Step 1: Thread the flag into Compass.** Read how the Compass FAB/sheet is presented in `PlacementsMainTabView.swift` (~line 42) and in `V2CompassView`. Add `isPlacement: Bool = false` to the Compass entry view and pass `true` from the placement shell. Default `false` keeps the D2C Compass tab unchanged.

- [ ] **Step 2: Filter the quick-actions bar.** In `V2CompassView.swift` quick-actions bar (~lines 667–680), filter out the "Compete today", "Coding capstone", and "Plan my days" actions when `isPlacement`. Read the current array/`ForEach` source; build a computed `quickActions` array that drops those three labels when placement.

- [ ] **Step 3: Filter the default suggestions.** In `CompassViewModel.swift` (~lines 233–241), the default suggestion set must exclude compete/capstone/plan for placement. Pass the flag into the view model (e.g. an `isPlacement` property set when the view appears) and filter the suggestion list accordingly.

- [ ] **Step 4: Suppress the competition banner.** In `V2CompassView.swift`, wrap the "Today's challenge" banner in `if !isPlacement`. In `CompassViewModel.swift`, skip the `GET /competition/relevant` fetch when placement (guard the call) so no banner state is populated.

- [ ] **Step 5: Compile-verify.**
Run:
```
cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && /opt/homebrew/bin/xcodegen generate && xcodebuild -scheme ScaleUp -destination 'generic/platform=iOS' -configuration Debug build CODE_SIGNING_ALLOWED=NO -quiet 2>&1 | tail -30
```
Expected: `BUILD SUCCEEDED`. Confirm the D2C Compass tab (defaulted `isPlacement: false`) is unchanged.

- [ ] **Step 6: Commit.**
```
cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && git add -A && git commit -m "Placement: scope Compass to prep options (hide compete/capstone/plan + challenge banner)"
```

---

## Task 3: iOS — Placement-clean immediate results + build bump

**Files:**
- Modify: `ScaleUp/Features/Placements/Assessments/PlacementInterviewTakeView.swift`
- Modify: `ScaleUp/Features/Placements/Assessments/PlacementDrillTakeView.swift`
- Modify: `ScaleUp/Features/Placements/Assessments/PlacementCapstonePairView.swift`
- Modify: `ScaleUp/Features/Placements/Assessments/PlacementsAssessmentsView.swift` (the MCQ loader path)
- Reference (do not show B2C result): `Features/Interview/Views/InterviewResultsView.swift`, `Features/Coding/Views/DrillResultView.swift`, `Features/Coding/Views/CapstoneResultView.swift`, `Features/Diagnostic/Views/DiagnosticResultsView.swift`
- Modify: `project.yml` (build bump)

**Interfaces:**
- Consumes: the existing `PlacementAssessmentResultView(row:)` (the gated score-only-pre-close screen) and the existing `api.syncSession`/list-refresh used by `PlacementsAssessmentsView`.

**Goal:** When an engine take-flow was launched as a placement assessment, completing it must NOT present the B2C engine result screen (which shows retry / "see your plan" / "practice another" / reflection / replay / mastery). Instead, on completion the take-flow dismisses and the student is taken to the placement result for that assessment (score-only until the window closes; gated review after) — the same `PlacementAssessmentResultView` shown when tapping a graded row.

- [ ] **Step 1: Read each placement take-flow's completion path.** For interview, drill, and capstone take views, and the MCQ loader in `PlacementsAssessmentsView.swift`, identify where the engine reports completion and where it currently presents/embeds the B2C result view. Note the navigation/sheet mechanism each uses.

- [ ] **Step 2: Reroute interview completion.** In `PlacementInterviewTakeView.swift`, on interview completion, dismiss the take-flow (and the embedded `InterviewSessionView`'s `.results` state) without showing `InterviewResultsView`; signal `PlacementsAssessmentsView` to refresh and present `PlacementAssessmentResultView` for that row (mirror how the graded-row tap opens it). If the interview engine view always renders its own results internally, gate that B2C results UI behind a passed-in `suppressNativeResult: Bool` flag and have the placement take-view set it true.

- [ ] **Step 3: Reroute drill completion.** In `PlacementDrillTakeView.swift`, replace the direct `DrillResultView(grade:)` presentation with dismissal + placement-result handoff (same pattern as Step 2). If a brief acknowledgement is needed, show only score (no next-step/mastery/"try next time").

- [ ] **Step 4: Reroute capstone completion.** In `PlacementCapstonePairView.swift`, ensure completion closes to the placement assessments list + placement result, never the B2C `CapstoneResultView` (no "try again"/"reflection"/"replay").

- [ ] **Step 5: Reroute MCQ completion.** In `PlacementsAssessmentsView.swift`, the MCQ loader path must end on `PlacementAssessmentResultView`, not `DiagnosticResultsView`. Read the loader/sheet flow and present the placement result on finish.

- [ ] **Step 6: Bump build number.** In `project.yml`, set `CURRENT_PROJECT_VERSION: 203` (was 202).

- [ ] **Step 7: Compile-verify.**
Run:
```
cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && /opt/homebrew/bin/xcodegen generate && xcodebuild -scheme ScaleUp -destination 'generic/platform=iOS' -configuration Debug build CODE_SIGNING_ALLOWED=NO -quiet 2>&1 | tail -30
```
Expected: `BUILD SUCCEEDED`. The D2C engine flows (which do not pass through the placement take-views) must still show their normal result screens.

- [ ] **Step 8: Commit.**
```
cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && git add -A && git commit -m "Placement: end assessments on the placement result (no B2C retry/plan/reflection); build 203"
```

---

## Task 4: Android — Lean placement "You" tab

**Files:**
- Modify: `src/features/v2/screens/V2YouScreen.tsx`

**Interfaces:**
- Consumes: existing `const inPlacement = userContext?.persona === 'placement'` (already computed at line 99 from `selectUserContext`).

**Goal:** Same as Task 1, for RN. Hide, when `inPlacement`: the Saved/Liked/Playlists/History library chips (lines ~379–382), followers/following row (~300–309), "Become a Creator" card (~494–505), Open-to-Opportunities/hiring row (~440–451), Creator Hub section (~458–472). Keep everything else.

- [ ] **Step 1: Gate the library chips.** Wrap the four `<LibraryChip … />` (Saved/Liked/Playlists/History) block in `{!inPlacement && ( … )}`.

- [ ] **Step 2: Gate followers/following.** Wrap the followers/following `Pressable` count row (~300–309) in `{!inPlacement && ( … )}`.

- [ ] **Step 3: Gate hiring + creator.** Wrap the Open-to-Opportunities/hiring block (~440–451), the Creator Hub block (~458–472), and the Become-a-Creator card (~494–505) each in `{!inPlacement && ( … )}` (compose with their existing conditions, e.g. `{!inPlacement && hiringAvailable && ( … )}`).

- [ ] **Step 4: Type-check.**
Run:
```
cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && npx tsc --noEmit 2>&1 | tail -30
```
Expected: no new errors (exit 0; report any pre-existing errors unrelated to this change).

- [ ] **Step 5: Commit.**
```
cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && git add -A && git commit -m "Placement: lean You tab (hide B2C library/social/creator/hiring sections)"
```

---

## Task 5: Android — Compass scoped for placement

**Files:**
- Modify: `src/features/v2/screens/V2CompassScreen.tsx`

**Interfaces:**
- Consumes: `selectUserContext` from `src/store/slices/authSlice.ts` — import it and compute `const inPlacement = useAppSelector(selectUserContext)?.persona === 'placement'` (mirror V2YouScreen lines 97–99).

**Goal:** Same as Task 2, for RN. Show only Quiz me / Practice interview / Explain something / Make a note. Drop Compete today, Coding capstone, Plan my days. Hide the today's-challenge banner.

- [ ] **Step 1: Compute the placement flag.** Add the `selectUserContext` import and `const inPlacement = useAppSelector(selectUserContext)?.persona === 'placement'` near the top of the component.

- [ ] **Step 2: Filter the quick actions.** Where `COMPASS_QUICK_ACTIONS` is mapped (render ~lines 1057–1066), map over a filtered list when placement: drop the items whose `label` is "Compete today", "Coding capstone", or "Plan my days". Implement as `const actions = inPlacement ? COMPASS_QUICK_ACTIONS.filter(a => !['Compete today','Coding capstone','Plan my days'].includes(a.label)) : COMPASS_QUICK_ACTIONS;` and map over `actions`.

- [ ] **Step 3: Gate the challenge banner.** Wrap the today's-challenge banner (~lines 856–882) condition with `!inPlacement` (e.g. `{!inPlacement && unplayed && ( … )}`). Also guard `loadCompetitionStatus` (~line 411) to early-return when `inPlacement` so no banner state loads.

- [ ] **Step 4: Type-check.**
Run:
```
cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && npx tsc --noEmit 2>&1 | tail -30
```
Expected: exit 0, no new errors.

- [ ] **Step 5: Commit.**
```
cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && git add -A && git commit -m "Placement: scope Compass to prep options (hide compete/capstone/plan + challenge banner)"
```

---

## Task 6: Android — Placement-clean immediate results

**Files:**
- Modify: `src/features/placements/screens/PlacementsHomeScreen.tsx`
- Reference: `src/features/placements/screens/PlacementResultView.tsx` (the placement result, already gated)

**Interfaces:**
- Consumes: the existing `setResultRow(row)` → `PlacementResultView` modal (~lines 544–553) and the existing assessment-list refresh.

**Goal:** Same as Task 3, for RN. After completing an engine, the student must land on `PlacementResultView` (score-only pre-close), not the B2C `QuizResultsScreen` / `InterviewResultsScreen` (retry / plan / practice-more).

- [ ] **Step 1: Read the per-engine completion paths.** In `PlacementsHomeScreen.tsx`, review the MCQ route (`navigation.navigate('QuizSession' …)` → `QuizResultsScreen`, ~279–287), interview (`InterviewCameraCheck`→`InterviewLive`→`InterviewResultsScreen`, ~288–298), and the inline drill/capstone modals (~299–325). Identify each completion callback.

- [ ] **Step 2: Reroute MCQ + interview completion.** On completion of the placement-launched QuizSession/Interview flow, instead of letting it land on `QuizResultsScreen`/`InterviewResultsScreen`, return to the placement home and open `PlacementResultView` for the assessment row (refresh the list, then `setResultRow(row)`). If those engine screens are registered in `PlacementsStack` and navigated to directly, pass a route param (e.g. `placement: true`) and have the result screen either redirect to the placement result or hide all B2C-only actions (retry, see-plan, practice-more) — prefer redirecting so the student sees the consistent score-only screen.

- [ ] **Step 3: Reroute drill + capstone modals.** Ensure the inline drill/capstone completion closes the modal and opens `PlacementResultView` (via list refresh + `setResultRow`), never a B2C result with retry/reflection.

- [ ] **Step 4: Type-check.**
Run:
```
cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && npx tsc --noEmit 2>&1 | tail -30
```
Expected: exit 0, no new errors.

- [ ] **Step 5: Commit.**
```
cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && git add -A && git commit -m "Placement: end assessments on the placement result (no B2C retry/plan/reflection)"
```

---

## Final steps (after all 6 tasks)

- [ ] **iOS TestFlight:** archive + upload build 203 (the established pipeline): `xcodebuild … archive` then `-exportArchive` with `ExportOptions.plist` and the inline auth flags (`-authenticationKeyPath $HOME/.appstoreconnect/private_keys/AuthKey_A4MNMMCCVB.p8 -authenticationKeyID A4MNMMCCVB -authenticationKeyIssuerID 0bbf6f7f-a7cf-4b88-8759-4c85e5c0f240`). Verify "Upload succeeded".
- [ ] **Android:** leave for the team's manual APK/main build (no CI), unless an APK is explicitly requested.
- [ ] Report what changed on each surface and what the user will see after installing build 203.

## Self-Review notes (addressed)

- **Spec coverage:** Modules 1 (Tasks 1,4), 2 (Tasks 3,6), 3 (Tasks 2,5) of the design spec are all covered. Modules 4–6 (companies/notices/shelves) are out of scope for Phase 1 and get their own plans.
- **D2C safety:** every gate defaults to the existing behavior (`isPlacement: false` / `!inPlacement`), so the D2C path is provably unchanged.
- **Results tasks (3 & 6) are integration tasks:** they require reading the take-flow navigation before editing; the implementer must trace each engine's completion callback. These warrant the standard (not cheapest) model.
