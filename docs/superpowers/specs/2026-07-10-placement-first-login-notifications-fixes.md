# Placement First-Login Experience + Notifications + Counter Fix — Design Spec

**Date:** 2026-07-10 · **Status:** Approved (founder decisions locked) · **Scope:** backend + iOS + Android(RN) + TPO web
**HARD CONSTRAINT:** zero D2C impact. Every change is placement-gated (persona/enrollment), additive, or a shared-bug fix that preserves D2C behavior.

## Founder decisions (locked 2026-07-10)
- **D1 Funnel:** keep the enrollment stage machinery; completing the intro marks `diagnostic_done`; **relabel the stage "Onboarded"** in the TPO portal (display-only; API keys unchanged).
- **D2 Day-1 readiness:** **no fabricated numbers.** Ring renders LOCKED ("readiness unlocks after your first assessment or practice") until real evidence exists.
- **D3 Scope:** build the **full first-login hook** in this wave (welcome/objective → season screen → 2-minute AI win → Home), not just diagnostic removal.

## Workstream A — Remove the diagnostic for placement students (backend)
1. **New endpoint `POST /api/v2/me/placement-onboarding/complete`** (in `src/routes/v2/me.js`, beside the existing GET at :147):
   - Guard: `InstitutionEnrollment.findOne({ userId, status: { $in: ['registered','diagnostic_done','active'] } })` → 404 `NOT_PLACEMENT` if none (D2C can never hit it).
   - Effects: set `User.diagnosticComplete = true` and `v2NeedsOnboarding = false` (mirror `plan.js:46-49`); call `enrollmentProgressService.markDiagnosticDone(userId)` (best-effort, per D1); idempotent (repeat calls OK).
   - Response: `{ success: true, data: { ok: true } }`.
2. **Extend `GET /api/v2/me/placement-onboarding`** response (same route file, :147-175) with best-effort fields for the hook screens: `seasonName`, `seasonStartsAt`, `seasonEndsAt` (from the cohort's placement season), `cohortStudentCount` (count of non-withdrawn `InstitutionEnrollment` in the cohort). Missing data → fields null, never an error.
3. **`GET /api/v2/plan/today`: add `readinessSource`** (`'snapshot' | 'diagnostic' | 'knowledge' | 'default'`) reflecting which branch of the currentReadiness waterfall fired (`plan.js:231-237`). Additive for all callers; clients treat `'default'` as "no real evidence → locked ring". No numeric behavior changes.
4. **Recalibration guard (verify + fix if needed):** ensure no worker/cron auto-schedules the monthly recalibration diagnostic for users with zero completed diagnostic attempts. If such a path exists, gate it on a completed prior attempt.

## Workstream B — Notifications for institution assessments (backend)
All emission **gated behind env flag `PLACEMENTS_NOTIFICATIONS_ENABLED`** (default OFF; flipped on after mobile builds ship — old iOS inbox decoder throws on unknown types).
1. `src/models/Notification.js:6`: add types `assessment_assigned`, `assessment_results` (+ map entries in `notificationService._mapDataTypeToNotificationType`).
2. **On release** (`assessmentService.releaseAssessment`, `src/services/institution/assessment/assessmentService.js:66-88`): resolve cohort students via `InstitutionEnrollment.find({ cohortId, userId: { $exists: true } , status: { $ne: 'withdrawn' } }).select('userId')` → `notificationService.sendToUsers(userIds, { title, body, data: { type: 'assessment_assigned', assessmentId } })`. Title/body: `"New assessment: <title>"` / `"<title> is now open — closes <date>."` Best-effort (never fail the release on notify errors).
3. **On results unlock**: in `src/workers/assessmentSync.worker.js` (the 60s poller, `now > closesAt` branch at :50), on FIRST crossing set a new `Assessment.resultsNotifiedAt` (add field to `src/models/Assessment.js`) and notify the cohort: `"Results are out"` / `"Your <title> results are ready to review."` type `assessment_results`. Manual `closeAssessment` (`assessmentService.js:91`) triggers the same notify+guard.
4. Out of scope (follow-up): notice-posted notifications, opensAt-scheduled pre-open reminders.

## Workstream C — "Question 38 of 24" fix (backend, shared code — D2C-safe fix)
1. Add `totalEstimatedQuestions: { type: Number }` to `src/models/DiagnosticAttempt.js` and **persist it on the document** in `startAttempt` (`diagnosticService.js:291-304`) and `startRecalibration` (:896-909) — the existing dead cap at :436-442 then terminates attempts at the planned total.
2. Fallback for in-flight/legacy attempts: when `attempt.totalEstimatedQuestions` is null, derive `totalPlanned = attempt.poolQuestionIds?.length || totalQuestionsForAttempt(attempt.selfRatings)` instead of null.
3. **Freeze the pool:** `_ensureAttemptPool` (:349-424) must NEVER re-assemble/overwrite `poolQuestionIds` for an attempt that already has answers; if rehydration finds 0 docs, end the attempt gracefully (`done: true`) rather than serving a fresh batch.
4. Tests: attempt terminates at exactly the planned total; pool never regenerates mid-attempt; recalibration unaffected.

## Workstream D — TPO web funnel relabel (display only)
`app/org/dashboard/page.tsx:50,59`, `app/org/cohorts/[cohortId]/page.tsx:906,993`: label "Diagnostic done" → **"Onboarded"**. API keys (`diagnosticDone`, `diagnostic_done`) unchanged.

## Workstream E — iOS (placement-gated)
Repo: `ScaleUpDemo-f`. NOTE: working tree has in-flight moderation work (`V2MainTabView.swift`, `V2YouView.swift`, `SettingsView.swift`, `Features/Moderation/`) — do not touch those files.
1. **First-login flow** (replaces intro→diagnostic): `PlacementOnboardingIntroView` (already shows objective/branch/year/roll) becomes step 1 of a 3-step hook:
   - Step 1 Welcome/objective confirmation (existing screen, copy polish; CTA "Continue").
   - Step 2 **Season screen** (new, placement-only): season name/window, `cohortStudentCount` ("142 students from your college are preparing here"), top upcoming drives from the existing student drives API with bookmark buttons; CTA "Continue".
   - Step 3 **2-minute win** (new): one practice question (existing private-practice infra; seed competency = first objective competency) with AI feedback moment; completing it lights streak day 1; CTA "Go to my homepage".
   - Skip affordance on steps 2-3 ("Skip for now") → Home.
   - Final CTA (and skip) calls `POST /me/placement-onboarding/complete`, sets local `diagnosticComplete`, routes `.home` (change `AppState.proceedFromPlacementIntro`, AppState.swift:204-206; `resolveLaunchState` :77-81 unchanged).
2. **Locked readiness ring**: `PlacementsHomeView` renders locked state (padlock/"?" + "Readiness unlocks after your first assessment or practice") when `/plan/today` `readinessSource == 'default'`; replace the dead "Complete your diagnostic…" copy (:90).
3. **Notifications**: add `assessment_assigned`/`assessment_results` cases to `NotificationType` (`Models/AppNotification.swift:24-35`) **+ a decode-tolerant `.other` fallback**; tap-routing in `PushNotificationManager.handleNotification` deep-links to Assessments list / the assessment's results.
4. **Diagnostic clamps (D2C safety net)**: `DiagnosticQuestionView.swift:54` label `min(questionsAnswered+1, totalQuestionsTarget)`; progress capped at 1.0 (`DiagnosticViewModel.swift:65-68`).

## Workstream F — Android / React Native (placement-gated)
Repo: `ScaleUpAndroid` (logic in `src/`, TypeScript). Mirror E:
1. First-login 3-step hook (AppNavigator.tsx :144-155/:179-191 routes; intro `onStart` → complete endpoint → refresh user → `'home'`; fix the fetch-failure auto-advance at PlacementOnboardingIntroScreen.tsx:56,64 to land Home, not diagnostic).
2. Locked ring in `PlacementsHomeScreen.tsx` (replace :399 copy; use `readinessSource`).
3. **FCM token upload (Android push blocker):** in `src/services/pushNotifications.ts:53-56`, upload the token via existing `PUT /users/me { fcmToken }` on fetch AND on refresh. Add placement types + tap deep-links (`handleData`, `src/models/notification.ts`).
4. Diagnostic clamps: `QuestionScreen.tsx:143` + add `progress` to `DiagnosticNextQuestion` DTO and reconcile `totalQuestionsTarget` from `next.progress.total` (`diagnosticSlice.ts:97-127`).

## Rollout order
1. Backend A+B+C (B dark behind flag) + tests → deploy → verify.
2. Web D → deploy.
3. iOS E (build 210+) & RN F in parallel → TestFlight/APK.
4. Flip `PLACEMENTS_NOTIFICATIONS_ENABLED=true` on EC2 once builds are distributed.

## Non-goals
D2C flow changes; notice notifications; opensAt reminders; plan generation for placement students (surfaces tolerate plan-lessness); portal funnel re-architecture (two implementations stay, labels only).
