# Placement Phase B — Visual / UX Uplift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the visual craft of the placement student screens (Campus, Library, Home, Results) from sparse/flat scaffolding to a polished, intentional product — within the app's existing dark + gold identity — and fold in the drive **bookmark star** (backend already built). No backend changes; no new endpoints.

**Architecture:** A design-language pass applied consistently across both apps. One implementer owns ALL the screens per app (iOS, RN) so the card system, spacing, type hierarchy, and status colors are uniform. Reuses existing data + the already-shipped APIs (companies incl. `bookmarked`, notices, shelves, practice). Only the bookmark toggle adds calls (`POST/DELETE /me/placement/companies/:driveId/bookmark`, already deployed).

**Tech Stack:** iOS — Swift/SwiftUI (`ScaleUpDemo-f`). Android — React Native/TS (`ScaleUpAndroid`). No backend.

## Global Constraints

- **Zero D2C impact.** All edits are in placement screens/components. Do not touch D2C (V2) screens or shared components in a way that changes D2C rendering. If a shared card/style is reused, add placement-specific styling locally rather than altering the shared one.
- **Use existing design tokens.** Map every color to the app's existing token set (iOS `ColorTokens`/`V2Theme`; RN `Colors`/`V2Type`/`V2Common`). Do NOT introduce raw hex values or a new palette — this is craft within the current dark + gold identity. If a needed token doesn't exist (e.g. a status green), reuse the nearest existing one (the app already uses green for "open"/"good" and grey for muted).
- **Both apps**, kept visually consistent with each other.
- **Behavior unchanged.** Same data, same navigation, same taps — only the presentation improves. The bookmark star is the one new interaction.
- **Build/verify:** iOS `xcodebuild … build` → BUILD SUCCEEDED (build bump 208 → 209 in the iOS task). RN `npx tsc --noEmit` → exit 0.
- **Android safety:** never put an `<Icon>` inside a `<Text>` (row `View` with sibling icon + text).

## Design language (apply uniformly)

- **Card:** one elevated surface style — existing card background, ~14pt corner radius, 16pt inner padding, 12pt spacing between cards, a 1px hairline only where it groups content. No full-width flat blocks floating in empty space.
- **Hierarchy (weight/size, not color):** card title 16–17 semibold; the "hero" value (a drive's role · package, a score) 20+ bold; meta/labels 12–13 in the secondary text color; section eyebrow 11 uppercase, tracked, in gold.
- **Gold accent — restraint:** gold only for key numbers, the active/primary action, eyebrows, and status="upcoming". Body text stays in the neutral text tokens, never gold.
- **Status pills:** open = green token, upcoming = gold token, closed = grey/muted token, visited = muted. Same mapping on every surface (Campus + anywhere a drive status shows).
- **Monogram chip:** a small rounded square with the entity's first letter (company name) on a tinted fill, used instead of a generic building/megaphone glyph where an identity exists; keep a glyph only where there's no name.
- **Empty states:** every list gets a centered, quiet empty state with one directive line (copy below), not blank space.
- **Copy:** sentence case, plain, end-user framed. Empty states tell the student what will appear and what to do.

---

## Task 1: iOS — placement screens uplift + bookmark star + build 209

**Files (modify):**
- `ScaleUp/Features/Placements/Campus/PlacementsCampusView.swift` (+ its `PlacementsCampusApi.swift` for the bookmark calls)
- `ScaleUp/Features/Placements/Library/PlacementsLibraryView.swift`
- `ScaleUp/Features/Placements/Home/PlacementsHomeView.swift`
- `ScaleUp/Features/Placements/Assessments/PlacementAssessmentResultView.swift`
- `project.yml` (build 209)
- May add a small shared file `ScaleUp/Features/Placements/Core/PlacementsUI.swift` for reused bits (monogram chip, status pill, section header, empty state) — keep it placement-scoped.

**Interfaces:**
- Bookmark: `PlacementsCampusApi` add `func bookmarkDrive(_ id: String) async throws` (POST `/me/placement/companies/\(id)/bookmark`) and `func unbookmarkDrive(_ id: String) async throws` (DELETE same path). `PlacementDrive` already (or should) decode `bookmarked: Bool?` — add the field if missing.

- [ ] **Step 1: Build the shared placement UI bits.** In a new `PlacementsUI.swift` (placement-scoped), add small reusable SwiftUI views using existing tokens: `MonogramChip(text:)` (first letter, tinted rounded square), `StatusPill(status:)` (open/upcoming/closed/visited → green/gold/grey/muted), `SectionEyebrow(_:)` (uppercase tracked gold label), `PlacementEmptyState(icon:title:message:)`. Keep them tiny and token-driven.

- [ ] **Step 2: Campus uplift + bookmark star.** Redesign `PlacementsCampusView` drive cards: monogram chip (company first letter) on the left; company name (17 semibold) + **role · package** as the hero line (package bold/gold-number); a meta row with a calendar glyph + date and a CGPA/eligibility line in secondary; a `StatusPill` top-right; an **"in N days" countdown** chip when the drive date is in the future (computed from `driveDate`); and a **bookmark star** button (filled gold when `bookmarked`, outline otherwise) that toggles via `bookmarkDrive`/`unbookmarkDrive` with optimistic local state. Notices: monogram/megaphone, title 16 semibold, body 13 secondary (2-line clamp), pinned → a small pin + subtle gold left accent, unread → a gold dot; tap opens link/attachment (unchanged). Use `SectionEyebrow` for "Company drives" / "TPO notices" and `PlacementEmptyState` for each empty section ("No drives yet — recruiters your TPO adds for this season show up here." / "No notices yet — your placement office will post updates here.").

- [ ] **Step 3: Library uplift.** Redesign `PlacementsLibraryView` shelves: each shelf is a card with the shelf title (16 semibold) + an **item count** ("3 items") in secondary; items as rows with a type glyph (doc for file, link for link) in a tinted mini-chip, title + a 1-line note in secondary, a chevron when it has a url; tap opens (unchanged). Restyle the "Ask Compass" card as a subtle helper (smaller, secondary surface, not a primary card). Empty state: "No shelves yet — your TPO adds prep material here."

- [ ] **Step 4: Home tightening + practice surface polish.** In `PlacementsHomeView`, bring the readiness ring / objective / placement-season / practice / assessments cards into the shared card language (consistent padding/radius/eyebrows), ensure the objective name renders cleanly, and make the **Practice card** (from Phase A) match the card system. No behavior changes.

- [ ] **Step 5: Result polish.** In `PlacementAssessmentResultView`, give the score a clear hero treatment (big number, label, a subtle ring or bar), the competency/dimension breakdown clean bars with consistent spacing, and the Phase-A "Recommended practice" block styled as a distinct card. Keep the gated per-question review intact.

- [ ] **Step 6: Build bump.** `project.yml` CURRENT_PROJECT_VERSION 208 → 209.

- [ ] **Step 7: Compile-verify.** `cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && /opt/homebrew/bin/xcodegen generate && xcodebuild -scheme ScaleUp -destination 'generic/platform=iOS' -configuration Debug build CODE_SIGNING_ALLOWED=NO -quiet 2>&1 | tail -25` → BUILD SUCCEEDED.

- [ ] **Step 8: Commit.** `cd "/Users/nirpekshnandan/My Products/ScaleUpDemo-f" && git add -A && git commit -m "Placement UX: card-system uplift (Campus/Library/Home/Results) + drive bookmark star; build 209"`

---

## Task 2: Android — placement screens uplift + bookmark star

**Files (modify):**
- `src/features/placements/screens/PlacementsCampusScreen.tsx` (+ `src/features/placements/api/companiesApi.ts` for bookmark calls)
- `src/features/placements/screens/PlacementsLibraryScreen.tsx`
- `src/features/placements/screens/PlacementsHomeScreen.tsx`
- `src/features/placements/screens/PlacementResultView.tsx`
- May add `src/features/placements/components/PlacementsUI.tsx` for reused bits (MonogramChip, StatusPill, SectionEyebrow, EmptyState) — placement-scoped.

**Interfaces:**
- Bookmark: in `companiesApi.ts` add `bookmarkDrive(id)` (POST `/me/placement/companies/${id}/bookmark`) and `unbookmarkDrive(id)` (DELETE). `PlacementDrive` type gets `bookmarked?: boolean`.

- [ ] **Step 1: Shared placement UI components.** Create `PlacementsUI.tsx` (placement-scoped) with `MonogramChip`, `StatusPill`, `SectionEyebrow`, `EmptyState` using the existing `Colors`/`V2Type`/`V2Common` tokens. Icons always siblings of text in a row `View` (never inside `<Text>`).

- [ ] **Step 2: Campus uplift + bookmark star.** Mirror iOS Task 1 Step 2 in `PlacementsCampusScreen.tsx`: monogram chip, company + role·package hero, date/eligibility meta, `StatusPill`, "in N days" countdown, and a **bookmark star** toggling via `bookmarkDrive`/`unbookmarkDrive` with optimistic state; notices with pinned/unread treatment. `SectionEyebrow` headers + `EmptyState` for both sections (same copy as iOS).

- [ ] **Step 3: Library uplift.** Mirror iOS Task 1 Step 3 in `PlacementsLibraryScreen.tsx`: shelf cards with item counts, typed item rows (file/link glyph chips), subtle "Ask Compass" helper, empty state.

- [ ] **Step 4: Home tightening + practice polish.** In `PlacementsHomeScreen.tsx`, bring the cards into the shared card language and match the Practice card to the system. No behavior change.

- [ ] **Step 5: Result polish.** In `PlacementResultView.tsx`, hero score, clean breakdown bars, and style the Phase-A recommended-practice block as a distinct card.

- [ ] **Step 6: Type-check.** `cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && npx tsc --noEmit 2>&1 | tail -25` → exit 0.

- [ ] **Step 7: Commit.** `cd "/Users/nirpekshnandan/My Products/ScaleUpAndroid" && git add -A && git commit -m "Placement UX: card-system uplift (Campus/Library/Home/Results) + drive bookmark star"`

---

## Final steps (after both tasks)

- [ ] iOS: archive + upload **build 209** to TestFlight.
- [ ] Android: leave for the team's APK build.
- [ ] Report: the placement screens now share a consistent, polished card system with monogram identity, status pills, drive countdowns, the bookmark star, and real empty states. This completes the practice + UX spec.

## Self-Review notes (addressed)

- **Spec coverage:** Part 2 of the practice+UX spec (visual uplift of Campus, Library, Home, Results + bookmark star) is fully covered, one task per app.
- **Consistency:** one implementer per app owns all four screens + the shared `PlacementsUI` helpers, so the card system/status colors/spacing are uniform; the two app tasks mirror each other section-for-section.
- **Zero D2C impact:** all edits are placement-scoped; new shared bits live in placement folders; no D2C screen or shared-token change.
- **Reuse:** no backend; reuses shipped APIs; only the bookmark toggle is a new call (endpoint already deployed). The bookmark backend (`DriveBookmark` + `bookmarked` flag) is consumed here, completing that feature.
- **No placeholders:** each step names the exact screen + the concrete component treatment; the design language section gives the shared rules (card metrics, hierarchy, gold restraint, status mapping, monogram, empty states, copy) every step refers to.
