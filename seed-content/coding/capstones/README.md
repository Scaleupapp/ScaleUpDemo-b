# Capstone Seed Library

Hand-crafted ArtifactBundles of `type: 'capstone'`. The Content Generator
uses these as nearest-neighbour in-context examples when producing new
capstones at scale.

**Spec target (§4.3 + §14.1 — Phase B launch):**

| Role track    | Easy | Medium | Hard | Total |
|---------------|------|--------|------|-------|
| SWE           | 4    | 4      | 2    | 10    |
| Data Science  | 4    | 4      | 2    | 10    |
| AI Engineer   | 4    | 4      | 2    | 10    |
| **Total**     |      |        |      | **30**|

**Current state**: 3 reference bundles checked in (1 per role-track) so
the pipeline + validator + generator have a working in-context example.
The remaining 27 bundles are **content production** — the spec mandates
"reviewed by 3 external senior engineers (one per track)" before the
Generator-at-scale phase begins. That review process lives outside this
repo.

## Authoring a new capstone

1. Pick a role-track + difficulty cell that needs bundles.
2. Copy one of the existing reference bundles to a new file under the
   appropriate cell directory.
3. Edit:
   - `brief` — Jira-style ticket; clear, specific, no ambiguity
   - `acceptance_criteria` — bulletproof, testable
   - `starter_repo.files` — the starting state (multi-file)
   - `reference_solution.files` — THE GOLDEN ANSWER (never served to learner)
   - `visible_tests` — what the learner sees + can run during the session
   - `hidden_tests` — what runs only at submit (anti-cheat by construction)
   - `seeded_mistakes` — 1–2 plausible bugs Compass might suggest
   - `rubric_anchors` — 3–5 deterministic dimension/expected_score pairs
4. Bump `version` (start at 1).
5. Run `npm run seed:capstones` from the repo root to load + validate.
6. The validator (spec §4.2) will:
   - Run the starter through the sandbox (must build/install clean)
   - Run the reference_solution against ALL tests (must pass)
   - Run each seeded_mistake (must FAIL the tests it claims to)
   - Check visible_tests + hidden_tests are distinct
   - Check content_hash is unique
   - Cross-validate (Gemini) that the brief is unambiguous + difficulty
     matches the stated level

The validator failure path is exposed via the `HumanReviewQueue`
collection — a moderator triages flagged bundles.

## What you get for free

- Bundle is automatically `status: 'draft'` on load — only flips to
  `active` after the validator passes and (per spec §4.5) the
  `human_reviewed: true` flag is set in `generated_by`.
- The seed script idempotently upserts by `content_hash` so reloads
  don't create duplicates.
