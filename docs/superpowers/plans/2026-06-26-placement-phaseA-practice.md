# Placement Phase A — Practice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give placement students a private, performance-driven Practice experience: a backend that recommends practice on their weakest assessed competencies, a Practice hub reached from Home that launches the four engines (quiz/drill/capstone/interview) as private self-practice, and a "Recommended practice" block on the assessment result screen.

**Architecture:** One new cohort-scoped backend endpoint (`GET /me/placement/practice`) that reads the student's latest GRADED `AssessmentSession`, extracts the weakest competencies from `result.raw`, and returns recommendations + the four practice types. Practice itself reuses the EXISTING engine deep-launch the Compass FAB already uses (`V2TaskRouter` on iOS, `V2TaskRouterStore` on RN) — no new engine code, no new "practice session" model. Practice never creates an institution `AssessmentSession`, so it stays private and invisible to the TPO.

**Tech Stack:** Backend — Node/Express/Mongoose; tests `node:test` + `supertest` + `router._deps` DI stubs. iOS — Swift/SwiftUI (`ScaleUpDemo-f`). Android — React Native/TS (`ScaleUpAndroid`).

## Global Constraints

- **Zero D2C impact.** The endpoint is enrollment-scoped behind placement auth; app changes are in the placement shell. The D2C engine flows are reused unchanged.
- **Practice must NOT create an `AssessmentSession`.** It uses the existing engine deep-launch (the same one Compass uses), which produces private Quiz/Drill/Capstone/Interview sessions. The graded path (`/me/assessments/:id/start`) is untouched.
- **Private:** practice is never surfaced to the TPO and does not affect official scores. (Nothing new is written to any institution-visible collection.)
- **Both apps.**
- **Backend tests:** `node --test <file>` (node v20 via nvm; if not on PATH `~/.nvm/versions/node/v20.20.0/bin/node --test <file>`).
- **Deploy:** backend push `master`; iOS build bump 207 → 208 + TestFlight; RN commit `main`.
- **Contract:** `GET /api/v2/me/placement/practice` → `{ success, data: { hasAssessment: boolean, recommendations: Rec[], types: PracticeType[] } }` where `Rec = { competency: string, score: number, suggestedType: 'quiz', topic: string, reason: string }` and `PracticeType = { key: 'quiz'|'drill'|'capstone'|'interview', label: string }`.

---

## File Structure

**Backend:** modify `src/routes/institution/studentAssessments.js` (add the route + an `AssessmentSession` "latest graded" lookup + a small competency-extraction helper); test `src/test/institution/placementPractice.route.test.js`.

**iOS:** create `ScaleUp/Features/Placements/Practice/PlacementsPracticeApi.swift` + `PlacementsPracticeView.swift`; modify `ScaleUp/Features/Placements/Home/PlacementsHomeView.swift` (Practice card → opens Practice screen) + `ScaleUp/Features/Placements/Assessments/PlacementAssessmentResultView.swift` (recommended-practice block); modify `project.yml` (build 208).

**Android:** create `src/features/placements/api/practiceApi.ts` + `src/features/placements/screens/PlacementsPracticeScreen.tsx`; modify `src/features/placements/screens/PlacementsHomeScreen.tsx` (Practice card) + `src/features/placements/screens/PlacementResultView.tsx` (recommended-practice block).

---

## Task 1: Backend — practice recommendation endpoint

**Files:** Modify `src/routes/institution/studentAssessments.js`; Test `src/test/institution/placementPractice.route.test.js`.

**Interfaces:**
- Consumes: the router's existing `getAuth()` + `getEnrollment()`; add a DI getter `getAssessmentSession()` (it already exists in this file — reuse it) for the latest-graded lookup.
- Produces: `GET /placement/practice` → `{ success, data: { hasAssessment, recommendations, types } }`. `recommendations` are the 2–3 weakest competencies from the student's most recent graded `AssessmentSession`, each mapped to a quiz suggestion. `types` is always the four engines.

Competency extraction: `result.raw.competencyBreakdown` (MCQ) is an array of `{ competency, percentage }`. Interview/capstone use `raw.dimensions`/`raw.dimension_scores` (`{ name, score }`); drill uses `raw.rubric_breakdown` (`{ criterion|dimension, score }`). Normalize each to `{ name, score }`, sort ascending by score, take up to 3.

- [ ] **Step 1: Write the failing test.** `src/test/institution/placementPractice.route.test.js` (mirror `placementCompanies.route.test.js` DI mount with `router._deps`):
```js
'use strict';
const test = require('node:test'); const assert = require('node:assert');
const express = require('express'); const request = require('supertest');
const router = require('../../routes/institution/studentAssessments');
function appWith(deps) { router._deps = deps; const a = express(); a.use(express.json()); a.use('/api/v2/me', router); return a; }
const authStub = (userId) => (req, _res, next) => { req.user = { userId }; next(); };

test('practice: recommends weakest competencies from latest graded MCQ session', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([{ cohortId: 'c1' }]) }) },
    AssessmentSession: { findOne: () => ({ sort: () => ({ lean: async () => ({
      _id: 'sess1', status: 'graded',
      result: { raw: { competencyBreakdown: [
        { competency: 'Project Tracking', percentage: 30 },
        { competency: 'Risk Management', percentage: 80 },
        { competency: 'Stakeholder Comms', percentage: 45 },
      ] } },
    }) }) }) },
  });
  const res = await request(app).get('/api/v2/me/placement/practice');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.hasAssessment, true);
  // weakest first
  assert.strictEqual(res.body.data.recommendations[0].competency, 'Project Tracking');
  assert.strictEqual(res.body.data.recommendations[0].score, 30);
  assert.strictEqual(res.body.data.recommendations[0].suggestedType, 'quiz');
  assert.strictEqual(res.body.data.recommendations[0].topic, 'Project Tracking');
  assert.ok(res.body.data.recommendations.length <= 3);
  // types always present
  assert.deepStrictEqual(res.body.data.types.map((t) => t.key), ['quiz', 'drill', 'capstone', 'interview']);
});

test('practice: no graded session → hasAssessment false, empty recommendations, types still present', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([{ cohortId: 'c1' }]) }) },
    AssessmentSession: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) },
  });
  const res = await request(app).get('/api/v2/me/placement/practice');
  assert.strictEqual(res.body.data.hasAssessment, false);
  assert.deepStrictEqual(res.body.data.recommendations, []);
  assert.strictEqual(res.body.data.types.length, 4);
});

test('practice: empty when no enrollment', async () => {
  const app = appWith({ auth: authStub('stu1'), InstitutionEnrollment: { find: () => ({ lean: async () => ([]) }) } });
  const res = await request(app).get('/api/v2/me/placement/practice');
  assert.strictEqual(res.body.data.hasAssessment, false);
  assert.deepStrictEqual(res.body.data.recommendations, []);
});
```

- [ ] **Step 2: Run to confirm failure.** `node --test src/test/institution/placementPractice.route.test.js` → FAIL (route 404).

- [ ] **Step 3: Implement the route.** In `src/routes/institution/studentAssessments.js`, add a helper + the route before `module.exports`:
```js
const PRACTICE_TYPES = [
  { key: 'quiz', label: 'Quiz' },
  { key: 'drill', label: 'Coding drill' },
  { key: 'capstone', label: 'Capstone' },
  { key: 'interview', label: 'Mock interview' },
];

// Normalize an engine result.raw into [{ name, score }] competency rows.
function extractCompetencies(raw) {
  if (!raw) return [];
  if (Array.isArray(raw.competencyBreakdown)) {
    return raw.competencyBreakdown.map((c) => ({ name: c.competency || c.name, score: typeof c.percentage === 'number' ? c.percentage : c.score }));
  }
  const dims = raw.dimensions || raw.dimension_scores;
  if (Array.isArray(dims)) return dims.map((d) => ({ name: d.name, score: d.score }));
  if (Array.isArray(raw.rubric_breakdown)) return raw.rubric_breakdown.map((r) => ({ name: r.criterion || r.dimension || r.name, score: r.score }));
  return [];
}

// GET /placement/practice — recommend practice on the student's weakest assessed competencies.
router.get('/placement/practice', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const Enrollment = getEnrollment();
    const enq = Enrollment.find({ userId });
    const enrollments = typeof enq.lean === 'function' ? await enq.lean() : await enq;
    const cohortIds = enrollments.map((e) => e.cohortId);
    if (!cohortIds.length) {
      return res.status(200).json({ success: true, data: { hasAssessment: false, recommendations: [], types: PRACTICE_TYPES } });
    }
    const AssessmentSession = getAssessmentSession();
    const sq = AssessmentSession.findOne({ userId, cohortId: { $in: cohortIds }, status: 'graded' }).sort({ gradedAt: -1 });
    const session = typeof sq.lean === 'function' ? await sq.lean() : await sq;
    if (!session) {
      return res.status(200).json({ success: true, data: { hasAssessment: false, recommendations: [], types: PRACTICE_TYPES } });
    }
    const comps = extractCompetencies(session.result && session.result.raw)
      .filter((c) => c.name && typeof c.score === 'number')
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);
    const recommendations = comps.map((c) => ({
      competency: c.name,
      score: Math.round(c.score),
      suggestedType: 'quiz',
      topic: c.name,
      reason: `You scored ${Math.round(c.score)}% on ${c.name}`,
    }));
    return res.status(200).json({ success: true, data: { hasAssessment: true, recommendations, types: PRACTICE_TYPES } });
  } catch (err) {
    console.error('[studentAssessments:practice]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load practice.' });
  }
});
```
(Confirm `getAssessmentSession()` already exists in the file — it does, used by the review route. If not, add it mirroring `getEnrollment()`.)

- [ ] **Step 4: Run to confirm pass.** `node --test src/test/institution/placementPractice.route.test.js` → PASS (3).

- [ ] **Step 5: Full suite + commit + push.**
`node --test src/test/institution/*.test.js` → green.
```
git add src/routes/institution/studentAssessments.js src/test/institution/placementPractice.route.test.js && git commit -m "Placement practice: GET /me/placement/practice (weakest-competency recommendations)"
git push origin master
```

---

## Task 2: iOS — Practice hub + Home/result entry points + build 208

**Files:**
- Create: `ScaleUp/Features/Placements/Practice/PlacementsPracticeApi.swift`, `PlacementsPracticeView.swift`
- Modify: `ScaleUp/Features/Placements/Home/PlacementsHomeView.swift`, `ScaleUp/Features/Placements/Assessments/PlacementAssessmentResultView.swift`, `project.yml`

**Interfaces:**
- Consumes: `GET /me/placement/practice`. Mirror `PlacementsCampusApi.fetchCompanies()` for the client style.
- Engine launch: reuse the SAME deep-launch the Compass FAB uses from the placement shell — `V2TaskRouter` routes: quiz → `.quizByTopic(topic:, weekNumber: nil)` (or `.quiz` with no topic for free practice), interview → `.interview(scenarioId: nil)`, drill → `.codingDrill(subtype: nil)`, capstone → `.codingCapstone`. Read `ScaleUp/Features/V2/Compass/CompassViewModel.swift` + `ScaleUp/Features/V2/Core/V2TaskRouter.swift` to find the exact dispatch call the Compass quick-actions use, and reuse it. The placement shell already hosts the task router (the Compass FAB works there).

- [ ] **Step 1: API + models.** In `PlacementsPracticeApi.swift`: `Codable` `PlacementPractice { hasAssessment: Bool; recommendations: [PracticeRec]; types: [PracticeType] }`, `PracticeRec { competency: String; score: Int; suggestedType: String; topic: String; reason: String }` (Identifiable via competency), `PracticeType { key: String; label: String }` (Identifiable via key). `func fetchPractice() async throws -> PlacementPractice` (GET `/me/placement/practice`).

- [ ] **Step 2: Practice screen.** `PlacementsPracticeView.swift`: a screen with a short header ("Practice is private — it won't affect your scores or be shown to your college."), a "Recommended for you" section (the `recommendations` as cards: competency · score% · "Practice quiz" → launches quiz on `topic`), and a "Practice any time" section (the four `types` as cards → each launches its engine). Each launch calls the V2TaskRouter dispatch identified in Interfaces (quiz uses the rec's `topic`; the four free-practice cards launch with no topic). Handle loading/empty (when `hasAssessment` is false, hide the recommended section and show only the four types). Use the existing placement theme tokens.

- [ ] **Step 3: Home entry.** In `PlacementsHomeView.swift`, add a "Practice" card (after the deadline/season card, before/around the assessments section ~line 22) titled e.g. "Sharpen up" with the top recommendation line (or "Practice anytime" when none) and a button that presents `PlacementsPracticeView`. Fetch practice in the Home view model or lazily when the card appears.

- [ ] **Step 4: Result recommendation block.** In `PlacementAssessmentResultView.swift`, after the breakdown section (~line 32-34), add a "Recommended practice" block: derive the weakest competency from the result's `raw.competencyBreakdown` already available on screen (or call `fetchPractice()`), and show 1–2 CTAs that launch practice (quiz on the weakest topic). Shown regardless of window-closed (practice is always allowed).

- [ ] **Step 5: Build bump.** `project.yml` CURRENT_PROJECT_VERSION 207 → 208.

- [ ] **Step 6: Compile-verify.** `cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && /opt/homebrew/bin/xcodegen generate && xcodebuild -scheme ScaleUp -destination 'generic/platform=iOS' -configuration Debug build CODE_SIGNING_ALLOWED=NO -quiet 2>&1 | tail -25` → BUILD SUCCEEDED. Do NOT archive/upload.

- [ ] **Step 7: Commit.** `cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && git add -A && git commit -m "Placement practice: Practice hub + Home card + result recommendation (private, engine deep-launch); build 208"`

---

## Task 3: Android — Practice hub + Home/result entry points

**Files:**
- Create: `src/features/placements/api/practiceApi.ts`, `src/features/placements/screens/PlacementsPracticeScreen.tsx`
- Modify: `src/features/placements/screens/PlacementsHomeScreen.tsx`, `src/features/placements/screens/PlacementResultView.tsx`

**Interfaces:**
- Consumes: `GET /me/placement/practice`. Mirror `companiesApi.ts`.
- Engine launch: reuse `V2TaskRouterStore.open(...)` (the same deep-launch the Compass uses): quiz → `{ kind: 'quizByTopic', topic }` (or `{ kind: 'compassHome', home: 'quiz' }` style for free practice — read `src/features/v2/core/V2TaskRouterStore.ts` for the exact shapes), interview → `{ kind: 'interview' }`, drill → `{ kind: 'compassHome', home: 'codingDrill' }`, capstone → `{ kind: 'compassHome', home: 'codingCapstone' }`. Confirm the placement shell hosts the task-router host (the Compass FAB works in placement).

- [ ] **Step 1: API.** `practiceApi.ts`: `export type PracticeRec = { competency: string; score: number; suggestedType: 'quiz'; topic: string; reason: string }`; `export type PracticeType = { key: 'quiz'|'drill'|'capstone'|'interview'; label: string }`; `export type PlacementPractice = { hasAssessment: boolean; recommendations: PracticeRec[]; types: PracticeType[] }`; `export async function fetchPractice(): Promise<PlacementPractice>` (GET `/me/placement/practice`, unwrap `.data`). Mirror `companiesApi.ts`.

- [ ] **Step 2: Practice screen.** `PlacementsPracticeScreen.tsx`: header (privacy note), "Recommended for you" (recommendations → launch quiz on `topic` via `V2TaskRouterStore.open`), "Practice any time" (four types → launch each engine). Hide the recommended section when `hasAssessment` is false. Match existing screen tokens.

- [ ] **Step 3: Home entry.** In `PlacementsHomeScreen.tsx`, add a "Practice" card after the deadline/season card (~line 449) showing the top recommendation (or a generic prompt) + a button navigating to `PlacementsPracticeScreen` (register it in the placements stack if needed).

- [ ] **Step 4: Result recommendation block.** In `PlacementResultView.tsx`, after the breakdown (~line 96), add a "Recommended practice" block deriving the weakest competency from `raw.competencyBreakdown` (or `fetchPractice()`), with CTAs launching practice via `V2TaskRouterStore.open`.

- [ ] **Step 5: Type-check.** `cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && npx tsc --noEmit 2>&1 | tail -25` → exit 0.

- [ ] **Step 6: Commit.** `cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && git add -A && git commit -m "Placement practice: Practice hub + Home card + result recommendation (private, engine deep-launch)"`

---

## Final steps (after all 3 tasks)

- [ ] Confirm box on the new backend commit + pm2 online.
- [ ] iOS: archive + upload **build 208** to TestFlight.
- [ ] Android: leave for the team's APK build.
- [ ] Report: students get weakest-competency practice recommendations on Home + the result screen, and a Practice hub to launch any of the four engines privately. Phase B (visual uplift) is next.

## Self-Review notes (addressed)

- **Spec coverage:** Part 1 (Practice) fully covered — recommendation endpoint (T1), Practice hub + Home entry + result block on both apps (T2, T3). Part 2 (visual uplift) is Phase B, separate plan.
- **Privacy invariant:** practice reuses the engine deep-launch only; nothing writes an `AssessmentSession` or any institution-visible record. The endpoint is read-only.
- **Data shape:** `competencyBreakdown` items use `competency` + `percentage` (verified in QuizAttempt/engineAdapters); `extractCompetencies` normalizes that plus the interview/capstone/drill shapes; weakest = lowest score.
- **Reuse:** no new engine code or practice-session model — the four launches use the existing `V2TaskRouter`/`V2TaskRouterStore` routes the Compass already uses.
- **Integration tasks:** T2/T3 require reading the Compass launch code to copy the exact dispatch — flagged in Interfaces; warrants the standard model.
