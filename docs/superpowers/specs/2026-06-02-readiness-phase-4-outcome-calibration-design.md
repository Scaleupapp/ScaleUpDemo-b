# Readiness Phase 4 — Outcome Capture + Calibrated Model — Design Spec

**Date:** 2026-06-02
**Status:** Approved design. **4A (Outcome Capture) → implement now. 4B (Calibrated Model) → documented; build once data is sufficient.**
**Repos:** `scaleup-backend` (Node/Express/Mongo), `ScaleUpDemo-f` (iOS/SwiftUI), `ScaleUpDemo-f-Android` (React Native/TS).

## Goal

Make readiness *truthful*: the % should predict real-world success (got the job, passed the exam, cleared the interview). That requires (4A) capturing real outcomes and (4B) calibrating the model against them. Outcome data is also the ultimate "proof is the moat" asset — it turns 3B's proof artifacts into **outcome-verified** credentials and yields claims like "X% of users who hit their target got the role."

## Scope & the hard dependency

ScaleUp captures **no real outcomes today** (only `UserObjective.status='completed'`, a weak "the plan ended" proxy). So 4B cannot be built or validated until labeled outcomes accumulate. Phase 4 therefore splits:

- **4A — Outcome Capture (THIS plan).** Instrument the app to record real outcomes per objective, freezing the readiness context needed for 4B. Backend + iOS + Android. Independently valuable (proof verification, testimonials, retrospective moment).
- **4B — Outcome-Calibrated Model (documented below; separate future plan).** Turn accumulated `(readiness context → outcome)` pairs into a per-archetype success predictor that sets an evidence-based target. Gated by data volume + a flag.

**Out of scope for 4A:** the calibration math itself; recruiter verification of self-reported outcomes; Phase 4B's UI ("76% historically predicts success").

---

# PART 4A — Outcome Capture (build)

## Decisions locked during brainstorming

1. **Capture moment = target-date prompt + always-on "I got it!".** The primary prompt fires when the objective's `targetDate` passes with no resolved outcome; an always-available "I got it! 🎉" button lets users record a win the moment it happens.
2. **Objective-aware options** that normalize to a clean label for 4B.
3. **Success stamps the 3B proof** with "✓ ACHIEVED", and offers an optional one-line testimonial.

## Outcome taxonomy (user choice → normalized label)

Normalized `label`: `SUCCESS | PARTIAL | NOT_SUCCESS | PENDING | ABANDONED`.

| objectiveType | user-facing options → label |
|---|---|
| `interview_preparation`, `career_switch` | I got the role→SUCCESS · A different role→SUCCESS · Still interviewing→PENDING · It didn't work out→NOT_SUCCESS · Paused this goal→ABANDONED |
| `exam_preparation` | Passed→SUCCESS · Didn't pass→NOT_SUCCESS · Haven't taken it yet→PENDING · (optional `detail`: score/percentile) |
| `upskilling`, `academic_excellence` | Nailed it→SUCCESS · Partly→PARTIAL · Not yet→PENDING |
| `casual_learning`, `networking`, default | Achieved it→SUCCESS · Somewhat→PARTIAL · Not really→NOT_SUCCESS · Not yet→PENDING |

The option set is produced by an objective-aware helper (mirrors `proveItService`), so clients render the right choices from a server-provided list.

## Data model

### `ObjectiveOutcome` (new) — `src/models/ObjectiveOutcome.js`
```js
{
  userId:        { ObjectId, ref User, index },
  objectiveId:   { ObjectId, ref UserObjective, index },
  objectiveType: String,
  label:         { String, enum: ['SUCCESS','PARTIAL','NOT_SUCCESS','PENDING','ABANDONED'] },
  rawChoice:     String,          // the exact option key the user tapped
  detail:        Mixed,           // optional, e.g. { examScore: 92 }
  source:        { String, enum: ['target_date_prompt','i_got_it','objective_close','reprompt'] },
  // ---- frozen readiness context (what makes 4B possible; captured at record time) ----
  context: {
    readinessAtCapture: Number,   // served readiness now (from latest ReadinessSnapshot)
    targetAtCapture:    Number,   // effective target now
    bandAtCapture:      String,
    readinessAtTarget:  Number,   // served readiness nearest the targetDate (from snapshot history) | null
    peakReadiness:      Number,   // max served value over the objective's snapshot history
    wasEverReady:       Boolean,  // did readyState.isReady ever fire
    coverageAtCapture:  Number,   // last shadow.coverage | null
    weeksToOutcome:     Number,   // weeks from objective.createdAt to now
  },
  testimonial:         String,    // optional free text
  allowTestimonialUse: { Boolean, default: false },
  resolved:            { Boolean, default: true }, // false only for PENDING (re-askable)
  respondedAt:         Date,
}
```
Index `{ userId:1, objectiveId:1 }`. A PENDING record is updatable on re-prompt (resolve to a terminal label later). One *resolved* outcome per objective is the goal; PENDING is a placeholder.

### `UserObjective` additions (additive)
```js
outcomePrompt: {
  due:        { Boolean, default: false }, // set when targetDate passed + no resolved outcome
  lastAskedAt: Date,
  snoozedUntil: Date,
}
```

### `ReadinessProof` (3B) additions (additive)
```js
achieved:   { Boolean, default: false },
achievedAt: Date,
// snapshot.achievedLabel — so the verify page can render "✓ ACHIEVED"
```

## Triggers

- **Target-date prompt (server-driven):** a once-daily job (`scripts/jobs/markOutcomeDue.js` run via the existing migration/cron path, or a lightweight in-request check) sets `outcomePrompt.due=true` on active objectives whose `targetDate < now` and that have no `resolved` outcome and aren't snoozed. The `/you/overview` + `/plan/today` payloads gain an **`outcomePrompt` block** (objective-aware options + objectiveLabel) when due — the app shows the capture sheet. Re-ask cadence: after a PENDING answer or a snooze, don't re-prompt for `REPROMPT_DAYS` (default 21), capped at `MAX_PROMPTS` (default 3) before going quiet.
- **Always-on "I got it!":** a Home affordance (near the Ready bar / proof) opens the same capture sheet anytime, `source='i_got_it'`.

## Endpoints

- `GET /api/v2/you/overview` and `GET /api/v2/plan/today` — gain an `outcomePrompt` block: `{ due, objectiveId, objectiveLabel, options: [{ key, label }] }` (null when nothing due). *(modify)* — folded in per the YAGNI call (no separate prompt endpoint).
- `POST /api/v2/you/outcome` *(new)* — body `{ objectiveId, rawChoice, detail?, testimonial?, allowTestimonialUse? }`. Resolves `rawChoice`→`label` via the taxonomy helper; freezes the readiness `context` (reads latest + historical `ReadinessSnapshot`, `objective.target`, `readyState`); creates/updates the `ObjectiveOutcome`; clears `outcomePrompt.due`; on `SUCCESS`/`ABANDONED` sets `objective.status` (`completed`/`abandoned`) + `completedAt`; on `SUCCESS` stamps the user's active `ReadinessProof`(s) for that objective `achieved=true, achievedAt`. Returns `{ ok, label, celebrate: label==='SUCCESS' }`.
- `POST /api/v2/you/outcome/snooze` *(new)* — sets `outcomePrompt.snoozedUntil = now + 14d`.

Telemetry: `outcome.prompt_shown`, `outcome.recorded` (label), `outcome.testimonial_given`.

## Clients (iOS + Android, parallel)

- **Capture sheet** — title (objective label + "you were X% ready"), the server-provided objective-aware options, submit → `POST /you/outcome`. On `celebrate`, a success screen (confetti/Seal) noting the proof now shows ACHIEVED + an optional testimonial field.
- **Trigger surfacing** — when `outcomePrompt.due`, present the sheet on Home appear (once per session until answered/snoozed); a "Remind me later" → snooze.
- **"I got it!"** — a small Home affordance always opens the sheet.
- iOS: `V2OutcomeSheet.swift`; Android: `V2OutcomeSheet.tsx`. Reuse the breakdown/what's-next card styling.

## Edge cases

- No objective / not past target and never tapped "I got it!" → no prompt.
- PENDING → record stored, `resolved=false`, re-prompt after `REPROMPT_DAYS` (capped). Resolving later updates the same record.
- User dismisses repeatedly → after `MAX_PROMPTS`, stop (still reachable via "I got it!").
- SUCCESS with no active proof → just record + mark objective; nothing to stamp.
- Outcome recorded but readiness history empty → freeze whatever's available (nulls allowed); 4B filters incomplete rows.
- Deepen/recalibration after outcome → outcome is historical/dated; unaffected.

## Testing

- Taxonomy helper: each objectiveType → expected options + rawChoice→label mapping.
- `POST /you/outcome`: freezes context from snapshot history; sets label; clears due; SUCCESS marks objective + stamps proof `achieved`; ABANDONED sets status.
- Prompt logic: `due` true only when targetDate passed + unresolved + not snoozed; cadence/cap respected.
- Snooze sets the window.
- Client: capture sheet renders server options; submit posts; celebrate path on SUCCESS.

## Success criteria (4A)

- When a user's target date passes, they're gently asked how it went; they can also self-report a win anytime.
- Each response writes an `ObjectiveOutcome` with a normalized label **and the frozen readiness context** — the dataset 4B needs.
- A SUCCESS marks the proof "✓ ACHIEVED" and (optionally) captures a testimonial.
- Fully additive; no change to existing readiness numbers.

---

# PART 4B — Outcome-Calibrated Model (documented; future plan)

**Trigger to build:** an admin metric (count of `resolved`, terminal-label `ObjectiveOutcome`s per archetype) crosses a threshold (~100/archetype). Until then this part is inert.

**Goal:** replace the heuristic target (P2) with an evidence-based one: the readiness level at which `P(success)` crosses a chosen threshold (e.g. 0.7) for that archetype — "for your goal, 76% is the readiness that historically predicts success" + reliability ("based on N similar journeys").

**Features** (per resolved outcome, from `ObjectiveOutcome.context`): `readinessAtTarget`, `peakReadiness`, `wasEverReady`, `coverageAtCapture`, primitive mix (competency assessmentTypes weighting), `weeksToOutcome`, archetype. **Label:** SUCCESS (incl. PARTIAL as a weighted/secondary class) vs NOT_SUCCESS. PENDING/ABANDONED excluded (censored).

**Staged approach:**
1. **Calibration curves** (first, simplest): per archetype, bucket `readinessAtTarget` (deciles) → empirical success rate. Directly yields the calibrated target + reliability. Robust at modest N.
2. **Logistic regression** `P(success)=σ(β·features)` once N supports it — interpretable, gives feature weights (validates which signals actually predict).
3. Richer models only if/when data justifies.

**Outputs:** `targetService.getEffectiveTarget` gains an outcome-calibrated branch (behind `FEATURE_OUTCOME_CALIBRATED_TARGET`): when the archetype has sufficient data, return the calibrated target + a `reliability` payload; else fall back to today's heuristic. Optionally a calibrated readiness % (raw→P(success) map).

**Success metrics:** calibration error (predicted vs actual success rate per bucket), discrimination (AUC), and target accuracy (do users who reach the calibrated target succeed at the intended rate). A monthly recompute job; never auto-ships a target that worsens calibration vs the heuristic.

**Data governance:** outcomes are self-reported (noisy) — acceptable for calibration; weight by recency; exclude obviously inconsistent rows. No PII in the model features.

## Open items for the 4A plan (not blockers)

- Target-date job: in-request lazy check vs a scheduled cron (`run-migration`/cron path) — pin in planning; lazy check on overview load is simplest for v1.
- Whether "I got it!" lives on the Ready bar, the proof affordance, or both — pin in planning (Home, near readiness).
- Testimonial storage/consent copy — minimal v1 (free text + a consent toggle).
