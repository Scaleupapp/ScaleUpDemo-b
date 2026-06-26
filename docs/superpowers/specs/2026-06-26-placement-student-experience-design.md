# Placement Student Experience Redesign — Design Spec

**Date:** 2026-06-26
**Status:** Approved (design); pending implementation plan
**Goal:** Make the placement student app a purpose-built placement product instead of a reskinned B2C app, and give the TPO real tools to populate the placement surfaces (Campus, Library, Placement Season).

---

## Context

ScaleUp Placements is the B2B2C placement-readiness vertical. Students enrolled by a college (TPO) use a placement-specific shell in the native iOS app (`ScaleUpDemo-f`, Swift) and the Android RN app (`ScaleUpAndroid`). The TPO manages everything through the web portal (`scaleup-web`, `/org`). The backend (`scaleup-backend`) is the shared contract.

The placement shell (`PlacementsMainTabView`) has four tabs — **Home / Campus / Library / You** — plus a floating **Compass** button. Today:

- **You** = the D2C `V2YouView()` reused 100% unchanged → leaks content-feed/social/creator/hiring features a placement student has no use for.
- **Campus** = empty placeholder ("Company drives", "TPO notices" coming-soon cards). No backend, no model, no TPO entry point.
- **Library** = empty placeholder ("Curated shelves coming soon"). No content model, no storage, no TPO entry point.
- **Immediate assessment result** = reuses the B2C engine result screens (retry / "see your plan" / reflection / replay / mastery / "practice another") which contradict the evaluative nature of a proctored placement assessment.
- **Compass** = the full D2C AI assistant (incl. Compete/competitions, Plan-my-days) exposed wholesale to placement students.
- **Placement Season** = cohort `placementSeason: { startDate, endDate }` only; no recruiting-companies list.

## Global Constraints

- **Zero D2C impact.** All new student endpoints are cohort-scoped behind the existing placement auth; all app changes are gated on `isPlacement`. The D2C (V2) experience must not change. (HARD constraint, project-wide.)
- **TPO write routes** gated to `institution_admin` / `tpo_head`; Notices and Shelves also allow `tpo_coordinator`.
- **Both apps:** every student-facing change ships on iOS (Swift) **and** Android (RN). Web is the TPO side.
- **Additive models only** — no changes to D2C models (`Content`, `ContentInteraction`, etc.).
- **Reuse existing infra:** auth middleware (`req.user.userId` for students; `institutionAuth` + `institutionScope` for TPO), the cohort/enrollment resolution already used by `personaResolver`, and the existing S3 setup that backs `Content.s3Key`.

## Suggested ship order

Even though this is one spec, implement in phases so value lands early and reviews stay small:

1. **Phase 1 — App cleanup (no backend):** Modules 1, 2, 3.
2. **Phase 2 — Companies & Drives:** Module 4.
3. **Phase 3 — TPO Notices:** Module 5.
4. **Phase 4 — Curated Shelves + Notes:** Module 6 (heaviest; depends on confirming S3 wiring).

---

## Module 1 — Lean placement "You" tab (app only)

**Problem:** `PlacementsMainTabView` renders `V2YouView()` unchanged, exposing B2C-only sections.

**Design:** Add a placement mode to `V2YouView` (e.g. an `isPlacement: Bool` init param defaulting to `false`, and the RN equivalent prop/selector). When placement:

**Hide:**
- "My Library" chip strip — Saved / Liked / Playlists / History
- Followers / Following counts (and their tap targets)
- "Become a Creator" card + creator application status
- "Open to Opportunities" (hiring marketplace)
- Creator Hub section

**Keep:**
- Profile header (avatar, name, username, bio, edit) — minus follower counts
- Readiness ring + target
- Stats block: this-week done, streak, top gap, time invested
- My objective (locked), My plan, Progress & analytics, Mock interviews & analytics
- **My notes** (Compass can still create notes)
- My Compass activity
- Settings, footer (version, member-since)

**Files (iOS):** `Features/V2/You/V2YouView.swift`, `V2YouSections.swift`; call site `Features/Placements/Core/PlacementsMainTabView.swift`.
**Files (RN):** the `V2YouScreen` reused by the placement shell + its navigation entry.

**No backend change.** Sections are hidden client-side; the underlying `/you/overview` payload is unchanged.

---

## Module 2 — Placement-clean immediate results (app; minimal backend)

**Problem:** Each engine's placement take-flow ends on the **B2C** result screen:
- MCQ → `DiagnosticResultsView` (HeroCard, calibration, "See your plan", "biggest gap — practice now", pattern card)
- Interview → `InterviewResultsView` ("Start New Interview", "practice another interview")
- Capstone → `CapstoneResultView` ("Try this capstone again", "Record reflection", "Watch replay")
- Drill → `DrillResultView` ("What to try next time", "practice another drill", mastery badge)

**Design:** Every placement-launched engine take-flow ends on **one placement result screen** = the existing `PlacementAssessmentResultView` behavior (already gated): **score only + "Detailed review unlocks once the assessment closes."** No retry, no plan, no reflection, no replay, no next-step, no mastery.

Concretely, the placement take-views must NOT present the B2C engine result view. On engine completion they dismiss the take-flow and surface the placement result (score-only pre-close; full review post-close — MCQ per-question already built; interview/capstone/drill show their dimension/rubric breakdown post-close).

**Files (iOS):** `Features/Placements/Assessments/PlacementDrillTakeView.swift`, `PlacementInterviewTakeView.swift`, `PlacementCapstonePairView.swift`, the MCQ loader path in `PlacementsAssessmentsView.swift`; the shared `PlacementAssessmentResultView.swift`.
**Files (RN):** the equivalent placement take screens + `PlacementResultView.tsx`.

**Backend:** none required for the gating (already returns `windowClosed` + gated `/review`). Confirm no engine `readResult` is needed beyond what exists.

---

## Module 3 — Compass scoped for placement (app only)

**Design:** When `isPlacement`, filter the Compass quick-actions + suggestions to: **Quiz me, Practice interview, Explain something, Make a note.** Hide **Compete today** and **Plan my days**, and suppress the "Today's challenge" competition banner.

**Files (iOS):** `Features/V2/Compass/V2CompassView.swift` (quick-actions bar), `CompassViewModel.swift` (default suggestions, competition banner fetch). Gate the quick-action list + competition banner on a placement flag passed into Compass.
**Files (RN):** the RN Compass quick-actions list + competition banner.

**No backend change** (the `/compass` modes already exist; we just don't surface compete/plan for placement).

---

## Module 4 — Companies & Drives (backend + web + app)

**New model `PlacementDrive`** (`src/models/PlacementDrive.js`):
```
{
  institutionId: ObjectId (ref Institution, required, index),
  cohortId:      ObjectId (ref InstitutionCohort, required, index),
  name:          String (required, trim),    // company name
  role:          String (trim),              // role / title
  package:       String (trim),              // CTC, free text e.g. "12 LPA"
  driveDate:     Date,
  eligibility:   String (trim),              // free text
  status:        String enum ['upcoming','open','closed','visited'] default 'upcoming',
  applyLink:     String (trim),
  notes:         String (trim),
  createdBy:     ObjectId (ref InstitutionUser),
  timestamps: true
}
```

**TPO routes** (`src/routes/institution/org.js` or a new `placementDrives.js`, mounted under `/api/institution`):
- `POST   /cohorts/:cohortId/drives` — create (admin/tpo_head/tpo_coordinator)
- `GET    /cohorts/:cohortId/drives` — list (any institution role)
- `PATCH  /cohorts/:cohortId/drives/:driveId` — update
- `DELETE /cohorts/:cohortId/drives/:driveId` — remove
All scoped via `institutionScope`.

**Student route** (`src/routes/institution/studentAssessments.js` sibling or a new `placementContent.js` mounted at `/api/v2/me`):
- `GET /me/placement/companies` — cohort-scoped list (resolve cohort via the student's enrollment, same pattern as the assessments list), sorted by `driveDate` asc then `createdAt`.

**Web (TPO):** a "Companies & Drives" section on the cohort detail page (`app/org/cohorts/[cohortId]/page.tsx`) — table of drives with add/edit/remove (inline or a small form), client method `institutionApi.listDrives/createDrive/updateDrive/deleteDrive`.

**App:** Campus "Company drives" card → real list (name, role, package, date, status chip; tap → applyLink/notes). Placement-Season area shows a next-up / count line derived from the same list. iOS `Features/Placements/Campus/PlacementsCampusView.swift` + a new `PlacementsCampusApi`; RN equivalents.

---

## Module 5 — TPO Notices (backend + web + app)

**New models:**
`InstitutionNotice` (`src/models/InstitutionNotice.js`):
```
{
  institutionId: ObjectId (ref Institution, required, index),
  cohortId:      ObjectId (ref InstitutionCohort, required, index),
  title:         String (required, trim),
  body:          String (required, trim),
  pinned:        Boolean default false,
  link:          String (trim),              // optional
  attachment:    { s3Key, fileName, mime } | null,   // optional file
  createdBy:     ObjectId (ref InstitutionUser),
  timestamps: true
}
```
`NoticeRead` (`src/models/NoticeRead.js`): `{ noticeId, userId, readAt }`, unique index `(noticeId, userId)`.

**TPO routes** (`src/routes/institution/notices.js`, `/api/institution`):
- `POST /cohorts/:cohortId/notices` — create (admin/tpo_head/tpo_coordinator)
- `GET  /cohorts/:cohortId/notices` — list + read counts (per notice: `readCount`, `total` from cohort enrollment count)
- `PATCH/DELETE /cohorts/:cohortId/notices/:id`
- File attachment uploaded via the **shared presign upload endpoint** (`POST /api/institution/uploads/sign`, defined in Module 6). Because Notices (Phase 3) lands before Shelves (Phase 4), this presign endpoint is **built in Phase 3** as a shared primitive and reused by Module 6. If S3 wiring is unconfirmed at Phase 3, Notices ship **link-only** (no attachment) until the storage gate clears.

**Student routes** (`/api/v2/me`):
- `GET  /me/placement/notices` — cohort-scoped, pinned first then newest, each with `read: bool` for this student (left-join NoticeRead).
- `POST /me/placement/notices/:id/read` — upsert NoticeRead.

**Web (TPO):** a "Notices" composer (title/body/pin/link/file) + list showing per-notice **read count** (e.g. "12 / 40 read"). Location: cohort detail page section (or a top-level `/org/notices` filtered by cohort — decide in plan; default to cohort page section for consistency with Drives).

**App:** Campus "TPO notices" card — pinned first, **unread badge**, tap opens detail (marks read; opens link/attachment). iOS + RN.

---

## Module 6 — Curated Shelves + Notes (backend + storage + web + app)

**New models:**
`Shelf` (`src/models/Shelf.js`):
```
{ institutionId, cohortId, title (required), order (Number default 0), createdBy, timestamps }
```
`ShelfItem` (`src/models/ShelfItem.js`):
```
{
  shelfId:  ObjectId (ref Shelf, required, index),
  type:     String enum ['link','file'] (required),
  title:    String (required, trim),
  url:      String (trim),                    // type=link
  s3Key:    String, fileName: String, mime: String,  // type=file
  note:     String (trim),                     // optional short note
  order:    Number default 0,
  createdBy: ObjectId (ref InstitutionUser),
  timestamps: true
}
```

**Storage:** reuse the existing S3 bucket that backs `Content.s3Key`.
- `POST /api/institution/uploads/sign` — mint a presigned PUT URL (returns `{ uploadUrl, s3Key }`) for TPO file uploads. **Shared primitive** — built in Phase 3 (first phase needing uploads, for Notices attachments) and reused here for shelf file items. Gated to TPO write roles.
- Student file reads return a presigned GET URL (short TTL) per file item.
- **PLANNING GATE:** confirm the S3 bucket name + IAM creds are present in the box `.env` (the D2C `Content` flow proves a bucket exists). If presigned upload from the browser is not readily wired, Phase 4 ships **link-only** first and adds file upload once storage is confirmed.

**TPO routes** (`src/routes/institution/shelves.js`, `/api/institution`):
- `POST/GET/PATCH/DELETE /cohorts/:cohortId/shelves`
- `POST/PATCH/DELETE /shelves/:shelfId/items` (+ list)

**Student route** (`/api/v2/me`):
- `GET /me/placement/shelves` — cohort-scoped shelves ordered by `order`, each with its items (link items as-is; file items with a freshly-signed GET URL).

**Web (TPO):** a "Shelves" manager — create/order shelves (Aptitude / DSA / HR Prep…), add **link** items (title + URL + note) and **file** items (title + upload via presigned URL + note).

**App:** Library tab renders real shelves; link items open in the system browser; file items open via signed URL (in-app web/PDF view). iOS `Features/Placements/Library/PlacementsLibraryView.swift` + a new `PlacementsLibraryApi`; RN equivalents.

---

## Data flow summary

```
TPO (web /org)  ──writes──▶  backend models (PlacementDrive, InstitutionNotice/NoticeRead, Shelf/ShelfItem)
                                   │ cohort-scoped
Student app  ──reads──▶  GET /me/placement/{companies,notices,shelves}  (+ POST notices/:id/read)
Student app  ──unchanged reads──▶  GET /me/assessments, /plan/today, /compass, /you/overview
```

## Testing

- **Backend:** unit tests per new route module mirroring the existing institution route tests (scope isolation: a TPO of institution A cannot read/write institution B's drives/notices/shelves; a student only sees their cohort's content). Read-acknowledgement upsert idempotency. Presign endpoint authz.
- **Apps:** compile-verify (iOS `xcodebuild`, RN `tsc`); manual pass of each placement surface with seeded data.
- **D2C regression:** confirm `isPlacement=false` paths (the default) render the unchanged You tab, Compass, and result screens.

## Out of scope (explicit)

- Recruiter/employer-facing surfaces (the hiring marketplace stays D2C-gated/off).
- D2C content model changes; algorithmic feed; likes/saves for placement.
- Per-company structured eligibility (CGPA/branch) and selection-round tracking (Essential company set only).
- Notice scheduling / push notifications (future).
