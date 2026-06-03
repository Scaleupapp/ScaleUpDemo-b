# Hire from ScaleUp — Employer Marketplace (v1) — Design Spec

**Date:** 2026-06-02
**Status:** Approved direction. Brainstormed end-to-end; visual mockups approved. Ready for implementation planning.
**Repos:** `scaleup-backend` (Node/Express/Mongo — new `/api/employer/*` + candidate consent), `scaleup-web` (Next.js/Vercel — employer site at `hire.scaleupapp.club`), learner apps (iOS `ScaleUpDemo-f`, Android `ScaleUpDemo-f-Android` — opt-in + connection inbox).

---

## Goal

Turn ScaleUp's verified-readiness data into a **talent marketplace**: hiring managers come to a web product, search for candidates who are *provably ready* for a role, see **why** each ranks (evidence-backed), and connect — only with candidates who opted in and approved the connection. The badge stays free; the employer side is the business (demand-gen → hiring pipeline). This is the "real prize" from the GTM plan (`PROOF_VIRALITY_MONETIZATION_PLAY_2026-06-02.md`): ScaleUp as a *verified-readiness talent pool*.

**One-line thesis:** Other platforms show claims; ScaleUp shows **evidence-ranked, independently-verifiable readiness** — and explains the ranking. That explainability is the moat.

## Locked decisions (from brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | v1 scope | **Full self-serve marketplace**, launched to a pilot cohort (manual fallbacks behind the scenes) |
| 2 | Platform | **Web-first** (`scaleup-web`), employer mobile app later |
| 3 | Consent | Candidate **opt-in** → profile + evidence visible to **verified employers**; **contact gated behind candidate approval** |
| 4 | Eligibility | **Career-intent objective + opted-in + has real evidence** (broad floor; ranking does the filtering) |
| 5 | Ranking | Highest **band first, descending**, per objective/role/company; achievers prioritized; **explainable** |
| 6 | Employer vetting | **Hybrid** — auto-verify work email → *browse* tier; manual approval → *contact* tier |
| 7 | Monetization | **Free pilot, NO billing in v1** (browse/contact split becomes free/paid later) |
| 8 | Architecture | **Extend existing apps** — `/api/employer/*` + employer auth in `scaleup-backend`; employer section of `scaleup-web`; candidate opt-in in the learner apps |

## Three trust gates (the spine)

```
Gate 1  Candidate OPTS IN            → TalentProfile becomes discoverable (identity masked)
Gate 2  Employer MANUALLY APPROVED   → only contact-tier employers can express interest
Gate 3  Employer expresses interest  → CANDIDATE APPROVES → identity + contact revealed, thread opens
```
Before Gate 3, the employer sees an **anonymized** card/profile (band, score, evidence, "why" — no name/photo/contact). Every reveal is a deliberate, logged candidate action. A candidate is never exposed to their current employer by accident; contact never leaks to spam.

---

## Architecture

Extend the existing stack — candidate data (readiness, proof, objectives, evidence) already lives in `scaleup-backend`, so we reuse it with zero cross-service plumbing.

- **Backend:** new `/api/employer/*` namespace (employer auth + role), new candidate-consent endpoints under the learner API (`/api/v2/you/talent*`), three new Mongo models, a ranking service, a search service. Reuse `proofService.buildSnapshot`, the coding `shareProfile` projection, `targetService`, `competencyMasteryService`, `ObjectiveOutcome`, `ReadinessProof`.
- **Employer web:** `hire.scaleupapp.club` — a section of `scaleup-web` (route group with its own layout) consuming `/api/employer/*`.
- **Learner apps:** an "Open to opportunities" opt-in surface + a connection-approval inbox (iOS first, Android parity in a later phase).

### Reuse, don't reinvent (takeaways from the existing public profiles)

ScaleUp already ships two recruiter-oriented public projections — the **readiness proof** page (`/r/[token]` ← `GET /api/public/proof/:token` ← `proofService.buildSnapshot`) and the **coding profile** (`/profile/[shareToken]` ← `GET /api/coding/public/profiles/:token`). The TalentProfile is their **consent-gated, employer-auth sibling**:

- The denormalized profile snapshot **is** `proofService.buildSnapshot`'s output (band, score, target, competencies, evidence{assessments, capstonesGraded, coveragePct}), extended with the coding `mastery` block for coding-eligible objectives.
- The employer **full-profile view** reuses the same render components (competency bars, stat grid, mastery bars, evidence footer, the "✓ verified" trust line). The **anonymized browse card** is a PII-stripped subset.
- A candidate's published **proof badge** is the verification anchor: linked from their TalentProfile and a top ranking signal.
- **One deliberate difference:** the badge is a *frozen* snapshot; the TalentProfile is **live/refreshed** (employers want current readiness), with the frozen badge linked as the verifiable credential.

---

## Data model

### `TalentProfile` (new) — the consented, discoverable projection of a candidate
One per opted-in candidate's career objective. Holds:
1. **Consent + preferences (candidate-owned):** `userId`, `objectiveId`, `optedIn`, `optedInAt`, `status` (active/paused), `contactPolicy` ('candidate-approved'), recruiter extras (`city`, `noticePeriod`, `workPref`). Pausing/withdrawing removes it from search immediately.
2. **Denormalized searchable snapshot (refreshed on key events):** `objectiveType`, `roleLabel` (`specifics.targetRole`), `targetCompany`, `readinessBand`, `readinessScore`, `target`, `competencies[]` (name+score, from buildSnapshot), `evidence{assessments, capstonesGraded, interviews, coveragePct}`, `codingMastery?`, `achieved` (from `ObjectiveOutcome`), `verified` (has active `ReadinessProof` + `proofToken`), `lastActiveAt`. Refreshed on: opt-in, new assessment, readiness change, outcome resolved, proof publish/revoke (event hooks or a lightweight recompute).
3. **Derived ranking signals** (computed at index/query time from the snapshot — see Ranking).

**Eligibility (a profile is indexed only if all hold):** career-intent `objectiveType` (`interview_preparation`, `career_switch`, job-focused `upskilling`) **AND** `optedIn` && `status==='active'` **AND** has real evidence (≥1 assessment/capstone/interview). Excludes `exam_preparation`, `casual_learning`.

### `EmployerAccount` (new) — employer identity + access tiers
`email` (work), `companyName`, `name`, `title`, `linkedIn`, `passwordHash` (or magic-link), `role:'employer'`, `emailVerified` (→ **browse tier**), `approvalStatus` ('pending'|'approved'|'rejected', manual → **contact tier**), `approvedBy`, timestamps. Separate from learner phone-auth.

### `ConnectionRequest` (new) — the Gate-3 flow
`employerId`, `talentProfileId`, `candidateUserId`, `objectiveId`, `status` ('requested'|'approved'|'declined'|'expired'), `message` (employer note), `createdAt`, `respondedAt`. On `approved`: reveal candidate identity + contact to *that* employer only, open a thread (in-app or email intro), notify both. Audit-logged.

---

## Discovery, ranking, explainability

### Search & filter axes (`employerSearchService`)
Role/objective (`roleLabel`+`objectiveType`), target company, readiness band, skills/competency names, location + work pref, proof level (Verified / Achieved / all). Operates over indexed `TalentProfile`s. Default view: the **anonymized ranked list** for the recruiter's filter.

### Ranking (`talentRankingService`) — deterministic match score
Within a filtered cohort, rank descending by a composite of signals (priority order):
1. **Achieved** (`ObjectiveOutcome` SUCCESS) — strongest
2. **Verified** (active published proof)
3. **Readiness band, then score** within band (objective-normalized via Phase-2 target, so same-role comparison is fair)
4. **Evidence depth** — volume + breadth (`coveragePct`)
5. **Recency** (`lastActiveAt`) — fresh signal outranks stale

Deterministic: same inputs → same order. Weights env-tunable; documented defaults.

### Explainable ranking (`talentRankingService.explain`) — the moat, made visible
For any candidate, return the signals that produced the rank, each backed by evidence (achieved-outcome, proof token, band vs target, coverage + competency count, recency). Powers the "Why this rank" panel and relative "why A > B" comparisons. Reuses the per-competency breakdown, coverage, outcome, and proof already computed. Doubles as **anti-gaming** — the recruiter always sees the receipts.

---

## Surfaces

### Employer web (`hire.scaleupapp.club`)
1. **Landing** — value prop + sign up.
2. **Signup + work-email verify** → browse tier; onboarding (company, role).
3. **Search / browse** — filter rail + **ranked anonymized candidate cards** (rank, locked avatar, band chip, ✓ marks, role·location·notice, skill chips, "why #N", score vs target, View-profile).
4. **Candidate profile (anonymized)** — header card with readiness ring; competencies + evidence cards (reusing proof/coding components); sticky **"Why this rank"** + **Express interest** (enabled once contact-tier approved).
5. **Connections** — interests sent, statuses, revealed contacts + message thread after approval.
6. **Account / settings.**

### Candidate side (learner apps)
1. **"Open to opportunities"** opt-in toggle with a plain-language "what employers see / never see" (✓/✕) explainer.
2. **"How employers see me"** preview + recruiter extras (city, notice, work pref).
3. **Connection inbox** — incoming interest → **Approve / Decline**; on approve, identity + contact shared (this employer only) and the thread opens.
4. Notifications.

### Admin / vetting (`scaleup-web/admin`)
Employer **approval queue** (pending → approve/reject for contact tier) + pool monitor with abuse flags. Reuse the existing `auth + rbac('admin')` pattern.

### Visual direction
**LinkedIn structure + Apple polish** (approved). Light theme: white cards on a soft-gray canvas, soft shadows, Plus Jakarta Sans, structured/scannable candidate cards a recruiter understands instantly, ScaleUp gold/teal as restrained accents (gold only on the score/verified, teal for actions). Reference mockup: `scaleup-web/design-mockups/hire-from-scaleup.html` (3 screens: search, candidate profile + "why this rank", candidate opt-in + inbox).

---

## Privacy / trust / DPDP (India)

- **Explicit, auditable consent**, granular (profile-visible vs. contact-allowed are separate records).
- **Data minimization:** anonymized until candidate approval; identity/contact revealed per-employer, per-approval only.
- **Instant revocation:** pause/withdraw → out of search immediately; existing connections can be cut.
- **Audit log** of every profile view + reveal; **employer ToS** (no scraping, no off-platform use).
- `noindex` everywhere; **no public token** into the pool — employer-auth gated.

---

## Edge cases
- Candidate opts in but objective not career-intent / no evidence → not indexed (silently).
- Candidate readiness drops / proof revoked → snapshot refresh updates band, `verified=false`; re-ranks.
- Employer email verified but not approved → browse only; Express-interest disabled with a clear "approval pending" state.
- Candidate pauses while a request is pending → request frozen; employer sees "no longer available."
- Achiever with thin coverage vs non-achiever with broad coverage → ranking weights resolve deterministically; explainability shows the trade.
- Duplicate connection requests → idempotent per (employer, candidate, objective).

## Testing
- `TalentProfile` eligibility (career-intent + opted-in + evidence; exclusions) and snapshot refresh on each trigger event.
- `talentRankingService` ordering (Achieved → Verified → Band → Evidence → Recency) + `explain` returns correct evidence-backed signals.
- `employerSearchService` filters (band, skills, location, proof level).
- `ConnectionRequest` state machine + the 3-gate reveals (no identity before approval; reveal scoped to one employer).
- Employer auth: email-verify → browse; approval → contact; unapproved cannot express interest.
- Privacy: anonymized projection leaks no PII; revocation removes from search; audit-log entries written.

## Success criteria
- A vetted employer can search "Backend Engineer", get an evidence-ranked anonymized list with a defensible "why" per candidate, express interest, and connect **only** after the candidate approves.
- A learner can opt in, see exactly what's shared, preview their profile, and approve/decline each connection.
- Zero PII exposure before candidate approval; instant revocation works.
- Reuses `buildSnapshot`/proof components — minimal new "what employers see" logic.

## Out of scope (v1)
Billing/payments (free pilot); employer mobile app; in-app realtime chat beyond a basic thread/email intro; per-objective (vs per-archetype) calibration; logistic-regression ranking. All deferred.

## Open items for planning
- **Snapshot freshness mechanism:** event hooks vs. a periodic recompute job vs. compute-on-read with cache — pin in planning after grepping the readiness write paths.
- **Employer auth:** password vs. magic-link (lean magic-link to reduce friction + avoid password storage).
- **Thread vs. email intro** for the post-approval conversation (start with email intro + a simple in-app thread).
- **Decompose:** this is large — the implementation plan should sequence the 4 phases (Foundation → Discovery → Connection → Polish), each independently shippable behind a flag.
