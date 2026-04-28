# Day-1 Diagnostic API

> API surface for `/api/v1/diagnostic/*`. Last updated: 2026-04-28.

The diagnostic feature establishes a baseline proficiency profile in the user's first session (new user) or refines existing signal (existing user). Behind feature flag `FEATURE_DAY1_DIAGNOSTIC=true`. All routes are JWT-authenticated.

## Lifecycle

```
start  →  self-rating  →  next-question (loop with answer)  →  finish
                     └→  abandon (drop / partial / auto-finish based on progress)
```

A `DiagnosticAttempt` document tracks state across the lifecycle. At-most-one in-progress attempt per user is enforced by a partial unique index.

## Endpoints

### POST `/api/v1/diagnostic/start`
Creates a new attempt. Responds 409 when the user has no mapped competencies on their primary objective, OR completed a diagnostic in the last 30 days against the same objective.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "attemptId": "...",
    "flowType": "new_user" | "existing_user_tune",
    "competenciesToAssess": [
      { "name": "sql", "questionCap": 3 }
    ]
  }
}
```

### POST `/api/v1/diagnostic/:attemptId/self-rating`
Captures the user's pre-quiz self-rating per competency, then assembles the question pool (LLM-generated for novel competencies, bank-cached otherwise). Pool composition adapts to the rating distribution.

**Body:**
```json
{
  "ratings": {
    "sql": "novice" | "familiar" | "proficient" | "expert" | "unsure"
  }
}
```

### GET `/api/v1/diagnostic/:attemptId/next-question`
Returns the next adaptive question selected from the pool by the stateless selector (difficulty climbs/drops based on the prior answer, capped per competency).

**Response 200:** `{ question: {...} }` or `{ done: true }` when the attempt has no remaining questions.

### POST `/api/v1/diagnostic/:attemptId/answer`
Records an answer.

**Body:**
```json
{
  "questionId": "...",
  "selectedAnswer": "B",
  "timeTaken": 12
}
```

### POST `/api/v1/diagnostic/:attemptId/finish`
Closes the attempt. Derives per-competency results, computes calibration delta vs self-rating, applies to KnowledgeProfile (`topicMastery.selfRating` + `calibrationAtBaseline`), seeds ConceptMastery for weak concepts, and triggers asynchronous plan regeneration. Sets `confidence` based on average answer time (<5s → low, 5–12s → medium, ≥12s → high).

### POST `/api/v1/diagnostic/:attemptId/abandon`
3-tier policy:
- `<30%` answered → drop without state change
- `30–70%` → partial-process (record what we have, mark `abandoned`)
- `≥70%` → treat as `finish`

### GET `/api/v1/diagnostic/synthesis`
For the existing-user E1 screen. Returns a summary of the user's most recent completed attempt for confirmation before re-tuning.

## Feature flag

When `FEATURE_DAY1_DIAGNOSTIC` is unset or `false`, all routes return 404 with `{ success: false, error: 'Diagnostic feature is disabled.' }`.

## Backward compatibility

- All schema changes are additive. The `selfRating`, `calibrationAtBaseline`, `confidence`, and `objectiveSnapshot` fields are optional with safe defaults.
- Plan generation consumes `diagnosticData` only when present; legacy plan flows are unaffected.

## Telemetry events

Emitted via `diagnosticTelemetryService`:
- `diagnostic.started` — `{ userId, flowType }`
- `diagnostic.self_rating_submitted` — `{ attemptId }`
- `diagnostic.finished` — `{ userId, questionsAnswered }`
- `diagnostic.abandoned` — `{ userId, strategy: 'dropped', pct }` (only emitted for the `<30%` drop path; the partial and auto-finish paths delegate to `finishAttempt`)
