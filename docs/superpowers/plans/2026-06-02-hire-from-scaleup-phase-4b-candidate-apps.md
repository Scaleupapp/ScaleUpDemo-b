# Hire from ScaleUp — Phase 4B (Candidate Apps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. iOS + Android are independent repos — build them in parallel (one implementer each).

**Goal:** The candidate side in both mobile apps — an "Open to opportunities" opt-in (toggle + recruiter details + the "what employers see / never see" explainer) and a **connection inbox** (approve/decline incoming employer interest, reveal employer on approval), wired to the Phase 1–3 `/api/v2/you/talent*` endpoints. Closes the loop so a pilot can run.

**Architecture:** A new "Open to work" screen + a connections inbox screen in each app, reached from the You tab. Both call the existing learner-authed V2 client. The feature is **self-gating**: the You-tab entry only appears if `GET /api/v2/you/talent` returns non-404 (the backend 404s when `FEATURE_EMPLOYER_MARKETPLACE` is off), so it stays invisible until the flag flips.

**Design source (port screen 3):** `scaleup-web/design-mockups/hire-from-scaleup.html` — the two phone frames (opt-in + interested-employers inbox). Match each app's existing V2 visual language (dark teal + gold), not the web's light theme — the mockup's phone screens are illustrative; render them in-app using the app's tokens.

## The endpoint contract (learner JWT; all 404 when flag off)
- `GET /api/v2/you/talent` → `{ optedIn: Bool, profile: TalentProfile | null }` where `profile` has `{ city, noticePeriod, workPref, snapshot:{ roleLabel, readinessBand, readinessScore, ... } }`
- `POST /api/v2/you/talent/opt-in` `{ city?, noticePeriod?, workPref? }` → `{ ok: true }` — **also used to EDIT prefs** while opted-in (it upserts prefs + rebuilds the snapshot). Errors: 400 `NO_OBJECTIVE` / 400 `NO_SNAPSHOT` / 400 `NOT_ELIGIBLE`.
- `POST /api/v2/you/talent/opt-out` → `{ ok: true }`
- `GET /api/v2/you/talent/connections` → `[ CandidateConnView ]`, `CandidateConnView = { connectionId, status('requested'|'approved'|'declined'), employer:'A verified employer', roleContext, message, createdAt, respondedAt, reveal?:{ companyName, name, email } }`
- `POST /api/v2/you/talent/connections/:id/approve` → `{ connectionId, status:'approved' }`
- `POST /api/v2/you/talent/connections/:id/decline` → `{ connectionId, status:'declined' }` (404 `NOT_FOUND`, 409 `ALREADY_RESPONDED`)

**Key UX decisions:**
- **No PATCH** — editing recruiter details calls `opt-in` again (idempotent upsert). Keep it simple.
- **Self-gating** — fetch `GET /talent` when the You tab / a settings row loads; on 404 hide the whole feature; on success show the entry + `optedIn` state.
- **Opt-in explainer is mandatory copy** (trust): "Employers see your readiness, skills & evidence — and why you rank. They never see your name, photo, phone or email until you approve a connection."
- **Inbox**: pending → masked employer + message + Approve/Decline; approved → "Connected" + revealed `{companyName, name, email}`; declined → greyed.

---

# iOS (repo: ScaleUpDemo-f, SwiftUI)

**Patterns to mirror:** `ScaleUp/Features/V2/Core/V2APIClient.swift` (`get<T>(path) -> V2APIResponse<T>`, `post<T,B>(path, body) -> V2APIResponse<T>`); the You tab `ScaleUp/Features/V2/You/{V2YouView,V2YouViewModel,V2YouSections}.swift`; an existing sheet like `V2ReadinessBreakdownSheet.swift` / `V2OutcomeSheet.swift` for sheet style. **Codable lesson:** new optional model fields MUST be `var x: T? = nil` (NOT `let` — a `let`+default is omitted from synthesized Decodable and breaks memberwise inits).

## iOS Task 1: Models + API calls
**Files:** Create `ScaleUp/Features/V2/Hiring/V2HiringModels.swift`, `V2HiringViewModel.swift`.
- [ ] Define Codable structs: `TalentState { var optedIn: Bool; var profile: TalentProfile? }`, `TalentProfile { var city: String?; var noticePeriod: String?; var workPref: String?; var snapshot: TalentSnapshot? }`, `TalentSnapshot { var roleLabel: String?; var readinessBand: String?; var readinessScore: Int? }`, `CandidateConn { var connectionId: String; var status: String; var employer: String?; var roleContext: String?; var message: String?; var createdAt: String?; var reveal: EmployerReveal? }`, `EmployerReveal { var companyName: String?; var name: String?; var email: String? }`. Empty-body/pref-body structs for posts.
- [ ] `V2HiringViewModel` (`@MainActor ObservableObject`): `@Published available: Bool? = nil`, `optedIn`, `profile`, `connections`, `pendingCount`, `loading`, `error`. Methods: `load()` (GET /talent → set available/optedIn/profile; on 404 set available=false), `optIn(city,notice,workPref)`, `optOut()`, `loadConnections()`, `approve(id)`, `decline(id)`. Use `V2APIClient.shared.get/post`. Map thrown 404 → `available=false`.
- [ ] Build check (Task 5).

## iOS Task 2: "Open to work" screen
**Files:** Create `ScaleUp/Features/V2/Hiring/V2OpenToWorkView.swift`.
- [ ] A toggle bound to `optedIn` (on→optIn, off→optOut), the mandatory explainer card (✓ they see / ✕ never see), and editable recruiter fields (city text, notice picker/text, workPref segmented onsite/remote/hybrid) that save via `optIn(...)`. Match the app's dark V2 styling. Show a friendly state if `NOT_ELIGIBLE`/`NO_SNAPSHOT` ("Take an assessment on a career goal to join").

## iOS Task 3: Connection inbox
**Files:** Create `ScaleUp/Features/V2/Hiring/V2ConnectionInboxView.swift`.
- [ ] List `connections`: pending card (masked "A verified employer" + roleContext + message + Approve/Decline buttons → `approve`/`decline`), approved card ("Connected" + `reveal.companyName/name/email`), declined greyed. The three-gate reassurance line at the bottom.

## iOS Task 4: You-tab entry (self-gated)
**Files:** Modify `ScaleUp/Features/V2/You/V2YouSections.swift` (or `V2YouView.swift`).
- [ ] Add an "Open to opportunities" row that appears ONLY when the hiring feature is available (drive from `V2HiringViewModel.available == true`, loaded when the You tab appears). The row shows opted-in state + a badge with `pendingCount`. Tapping opens `V2OpenToWorkView`; a secondary entry (or a section in that view) opens `V2ConnectionInboxView`. Keep it additive — don't disturb existing You sections.

## iOS Task 5: Build to TestFlight (controller does this)
- [ ] Bump `project.yml` `CURRENT_PROJECT_VERSION: 186 → 187`. Regenerate: `/opt/homebrew/Cellar/xcodegen/2.45.3/bin/xcodegen`; verify `grep "CURRENT_PROJECT_VERSION = 187" ScaleUp.xcodeproj/project.pbxproj`. Archive + export with the ASC API-key auth flags on BOTH steps; do NOT `rm -rf` the DerivedData glob (use `xcodebuild clean`). Commit `chore(ios): build 187 — Open to opportunities + connection inbox (Phase 4B)`.

---

# Android (repo: ScaleUpDemo-f-Android, React Native/TS, branch main)

**Patterns to mirror:** `src/features/v2/api/v2Client.ts` (the V2 API client); existing screens `src/features/v2/screens/{V2YouScreen,V2ReadinessBreakdownSheet,V2OutcomeSheet}.tsx`; the theme in `src/theme/colors` (V2Colors). Gate: `npx tsc --noEmit` clean for touched files.

## Android Task 1: API + types
**Files:** Create `src/features/v2/api/hiringApi.ts` (or add to `v2Client`).
- [ ] Typed calls + TS types mirroring the contract: `getTalent()`, `optIn(prefs)`, `optOut()`, `getConnections()`, `approve(id)`, `decline(id)`. Types: `TalentState`, `TalentProfile`, `CandidateConn`, `EmployerReveal`. Map a 404 from `getTalent` to an `available:false` signal (catch + sentinel).

## Android Task 2: "Open to work" screen
**Files:** Create `src/features/v2/screens/V2OpenToWorkScreen.tsx`.
- [ ] Toggle (Switch) bound to optedIn (on→optIn, off→optOut), the mandatory ✓/✕ explainer, editable recruiter fields (city TextInput, notice, workPref segmented), save via `optIn`. Dark V2 styling (V2Colors). Friendly `NOT_ELIGIBLE`/`NO_SNAPSHOT` state.

## Android Task 3: Connection inbox
**Files:** Create `src/features/v2/screens/V2ConnectionInboxScreen.tsx`.
- [ ] List connections: pending (masked employer + roleContext + message + Approve/Decline), approved ("Connected" + reveal), declined greyed. Three-gate reassurance line.

## Android Task 4: You-tab entry (self-gated) + navigation
**Files:** Modify `src/features/v2/screens/V2YouScreen.tsx` + the navigator that registers V2 screens.
- [ ] Add an "Open to opportunities" row visible ONLY when `getTalent()` succeeds (non-404), showing opted-in state + pending badge; navigate to `V2OpenToWorkScreen` / `V2ConnectionInboxScreen`. Register the two new screens in the navigator. Additive.

## Android Task 5: Typecheck, commit, push
- [ ] `npx tsc --noEmit` clean for the new/changed files (pre-existing unrelated errors ok). Commit `feat(hiring): Open to opportunities opt-in + connection inbox (Phase 4B)` and push to `main`.

---

## Self-Review (plan author)

**Spec coverage:** opt-in toggle + recruiter details + mandatory explainer (iOS T2 / Android T2 ✓), connection inbox with approve/decline + reveal-on-approval (iOS T3 / Android T3 ✓), self-gated You-tab entry so it's inert until the flag flips (iOS T4 / Android T4 ✓), wired to the real `/api/v2/you/talent*` contract (T1 each ✓), iOS TestFlight build 187 (T5 ✓), Android push (T5 ✓). Notifications/audit/analytics = Phase 4C.

**No PATCH** — prefs edit reuses `opt-in` (documented). **Self-gating** keeps the feature invisible pre-flag. **Codable var-default lesson** called out for iOS. Design ports the mockup's two phone screens into each app's native dark theme.

**Note for executors:** match each app's existing V2 screen idioms exactly (this codebase cares about consistency). The opt-in explainer copy is a trust requirement — keep it verbatim. Don't disturb existing You-tab sections; the entry is additive + self-gated.
