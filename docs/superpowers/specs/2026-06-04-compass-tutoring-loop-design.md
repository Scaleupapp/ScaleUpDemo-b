# Compass Tutoring Loop — Design Spec

**Date:** 2026-06-04
**Status:** Approved design, ready for implementation planning
**Repos:** `scaleup-backend` (Node/Express/Mongo), `ScaleUpDemo-f` (iOS/SwiftUI). Android inherits the backend capability and renders its own cards when it reaches Compass parity (separate track).

## Goal

Close the learning loop. After Progress Intelligence, Compass can **diagnose** ("your weakest topic is recursion, 35%, that's why you're stuck at 70%") but then stops — the learner is left to self-remediate. The Tutoring Loop makes Compass **teach the specific thing the learner keeps getting wrong, verify it with a short check, and surface measurable improvement in the learner's real mastery + readiness** — all inside the Compass chat, without leaving the conversation.

Headline experience: weak topic → targeted micro-explanation (grounded in the learner's actual misconceptions) → inline 4-question check → result card showing the before→after mastery delta → offer to tutor the next weak topic.

## Scope & decomposition

This is sub-project **#2** of the "make Compass amazing" roadmap (see `docs/superpowers/specs/2026-06-03-compass-progress-intelligence-design.md`). It builds directly on #1's read-only rails — specifically `compassProgressService.getTopicDetail` (the `get_topic_detail` tool's data) is the diagnosis + explanation-grounding source.

**In scope (this spec):** the conversational tutoring loop in Compass — the `request_tutoring` intent + proactive offer, a topic-grounded explanation, an inline check-quiz that reuses the existing quiz pipeline for scoring/mastery, and a result/delta card. Plus the iOS inline quiz-card renderer.

**Out of scope:** any NEW mastery-write path (we reuse the existing quiz→mastery pipeline); plan/objective mutation; an explicit "misconception resolved" write (stays implicit via mastery/FSRS improvement); multi-topic study plans; coding skill-axis tutoring (coding has its own drill loop); voice; Android UI.

## Decisions locked during brainstorming

1. **Hybrid shape.** The loop lives in Compass chat (offer + explanation as messages/cards), but the check + result render as an **inline quiz card sequence** — the user never leaves the conversation. The check is still a *real* generated quiz driven through the existing take/score endpoints, just with an inline UI instead of the full `QuizSessionView`.
2. **Reuse the proven write path — no new mastery write.** The check is taken via the existing `start → answer → complete → scoreQuiz → quizAnalyzer → updateMastery + save` pipeline (idempotent). Mastery + readiness update for free; the "don't disrupt the journey" guardrail is satisfied by *reusing* the battle-tested path rather than introducing a new one.
3. **Both triggers.** User-initiated (`request_tutoring` intent, like the drill intent) AND a proactive offer when a weak topic surfaces.
4. **MCQ check-quizzes** (request `assessmentType: 'recall'`) so the inline renderer stays simple; per-question immediate feedback (a teaching moment on the misconception-tagged distractors).
5. **One topic per loop, chain-to-next.** No multi-topic study plans in v1.
6. **Honesty.** Teaching is free/budget-capped; numbers only move when the learner answers real questions. The result card is honest when a check goes poorly (small/no delta), and offers re-teach or spaced review.

---

## Architecture

The Tutoring Loop is thin orchestration over existing machinery. **Reused as-is:** `quizGenerationService` / `quizTriggerService` (`POST /api/v1/quizzes/request`, async trigger→poll→fetch, `questionCount` clamped 1–20), the take/score endpoints (`startAttempt`/`submitAnswer`/`completeQuiz` → `quizScoringService.scoreQuiz` → `quizAnalyzer` worker → `knowledgeService.updateMastery` 60/40 blend → `profile.save()`), `compassProgressService.getTopicDetail`, the Compass `callLLM` + daily token budget, and the iOS suggested-action-card + `.sheet`/inline presentation pattern.

### Backend (`scaleup-backend`)

**1. `request_tutoring` intent** — new detector mirroring `src/services/v2/compassIntent.js` (`detectDrillRequest`): a keyword pre-filter (`"tutor me"`, `"help me get better"`, `"help me improve"`, `"teach me"`, `"get better at"`, `"improve at"`, `"explain and quiz"`) → cheap Haiku classifier (coding `llmRouter`, `taskId:'drill_grade_prompt'` pattern) → returns `{ type: 'start_tutoring', topic }` (topic may be null → resolve to the learner's top weak topic). Wired into the orchestrator intent block (`compassOrchestrator.js` ~378–396) alongside `detectDrillRequest`, for `INTENT_ELIGIBLE_MODES` (conversation/coach/mentor/tutor). Lives in `compassIntent.js` (extend) or a sibling `tutoringIntent.js`.

**2. Proactive-offer hook** — in `handle()`, after a turn whose tools surfaced weak topics (`explain_readiness` / `list_weak_topics` invoked) or a coach/why-stuck answer, if `response.output.suggested_action` isn't already set, attach `{ type: 'start_tutoring', topic: <top weak topic>, score }`. Best-effort, never throws.

**3. `tutor_topic` mode (the one new LLM call)** — `POST /api/v2/compass` `{ mode: 'tutor_topic', payload: { topic } }`. Handler:
- `const detail = await compassProgressService.getTopicDetail(userId, topic)` → mastery score/level/trend + `misconceptions[{tag,explanation}]` + `dueConcepts`.
- Build a system prompt: *"You are tutoring `<topic>`. The learner is `<level>` (`<score>`%). Their recurring misconceptions: `<tags+explanations>`. Teach concisely (4–8 sentences) with 1–2 worked examples that directly fix THOSE misconceptions. Don't dump everything about the topic. End by inviting a quick check."*
- `callLLM(...)` (Claude `COMPASS_MODEL`, budget-capped via the existing path; capped → existing copy).
- Return `{ mode:'tutor_topic', output: { reply, cards: [topic_detail card], action: { type: 'start_check_quiz', topic, questionCount: 4, beforeScore: detail.score } } }`. Persist the turn to `CompassConversation`.

**4. `tutor_result` mode (reflection + delta)** — `POST /api/v2/compass` `{ mode: 'tutor_result', payload: { topic, attemptId, beforeScore } }`, called by iOS after the check completes. Handler:
- Read the completed `QuizAttempt` by `attemptId` (ownership-checked) → `checkScore = attempt.score.percentage`.
- Re-read `getTopicDetail(userId, topic)` → `afterScore` (best-effort; the async mastery write usually lands within ~1–2s — iOS calls this after a short delay; if `afterScore` hasn't moved yet, report it as provisional).
- `callLLM` a short reflection grounded in the real numbers (what improved / what to revisit) — "DO NOT invent stats" discipline; numbers come from the attempt + mastery.
- Return `{ output: { reply, cards: [{ type:'tutoring_result', payload: { topic, checkScore, beforeScore, afterScore, delta: afterScore-beforeScore } }], action: { type:'start_tutoring', topic: <next weak topic> } } }`.

**5. Check-quiz** — reuse `POST /api/v1/quizzes/request` with `{ topic, questionCount: 4, assessmentType: 'recall', source: 'tutoring' }`. `source:'tutoring'` tags it for telemetry; `recall` keeps questions MCQ. **No new generation/scoring/mastery code.**

**New card type:** `tutoring_result` (added to the card system / OpenAPI `CompassCard` enum). The `start_tutoring` / `start_check_quiz` actions extend the existing `suggested_action`/action mechanism.

### iOS (`ScaleUpDemo-f`)

**1. Offer card** — handle `suggested_action.type == "start_tutoring"`: render "🎯 Improve: \<topic\> — \<score\>% · [Start]" (clone `suggestedActionCard` in `V2CompassView.swift`). Tap → send `POST /compass { mode:'tutor_topic', payload:{ topic } }`.

**2. Explanation** — the `tutor_topic` reply renders as a normal Compass message + the existing `topic_detail` card + a "Ready for a quick check?" CTA from the `start_check_quiz` action.

**3. `CompassInlineQuizCard` (the main new component)** — given `{ topic, questionCount, beforeScore }`:
- `QuizService.requestQuiz(topic:, questionCount: 4, assessmentType:'recall', source:'tutoring')` → poll `checkTriggerStatus` (≤30×2s) → `fetchQuiz`.
- `QuizService.startQuiz(id:)` then render questions **one at a time inline**; on answer → `submitAnswer`, show immediate correct/incorrect + the question's `explanation`; Next.
- On last question → `completeQuiz` → capture `attemptId`.
- Then (after a short delay) drive the result: `POST /compass { mode:'tutor_result', payload:{ topic, attemptId, beforeScore } }`.
- Reuses `QuizService` end to end — only the UI is new (no `QuizSessionView`).

**4. Result/delta card** — render the `tutoring_result` card: check score + before→after mastery delta (with an "updating…" state if `afterScore` is provisional) + the chained `start_tutoring` offer for the next weak topic.

### Loop state (client-tracked)
`{ topic, beforeScore (from start_check_quiz.action), triggerId, quizId, attemptId }` — threaded through the inline quiz card; `beforeScore` + `attemptId` are what the `tutor_result` call needs.

---

## Data / mastery flow (end to end)

1. Trigger → `start_tutoring` offer card.
2. Start → `tutor_topic`: capture `beforeScore` (from `getTopicDetail`), deliver targeted explanation.
3. Check → `requestQuiz(source:'tutoring')` → poll → take inline via `startQuiz/submitAnswer/completeQuiz`.
4. `completeQuiz` → `scoreQuiz` (sync: saves attempt + `topicBreakdown`) → enqueues `quizAnalyzer` → `updateFromQuizAttempt` → `updateMastery` (60/40) + `profile.save()` + journey/plan adaptation (async, ~seconds).
5. Result → `tutor_result` reads the attempt (exact check score) + re-reads mastery (`afterScore`), shows the delta; readiness reflects the change lazily on the next `/you/overview` or Compass read.

**One write path, already proven.** The loop itself writes nothing to mastery/readiness directly.

## Error handling & guardrails

- **Quiz-gen fail/timeout** (poll exhausts) → fallback card: "couldn't build a check right now — here's what to review" (the explanation already delivered value).
- **Budget cap** on `tutor_topic`/`tutor_result` → existing capped copy.
- **User abandons mid-check** → no mastery write (attempt stays `in_progress`; existing idempotency covers a later resume).
- **Delta not yet landed** at result time → show the exact check score immediately, mark the mastery delta provisional, refresh on next read.
- **Unknown/ambiguous topic** → resolve to the nearest known weak topic or ask the user to confirm.
- **Read-only on everything except the quiz pipeline.** No plan/objective writes. No direct `updateMastery` call (if a future variant ever calls it directly, it MUST `await result.profile.save()` — but v1 does not).

## Testing

- **Backend:** `request_tutoring` intent (keyword pre-filter + classifier, mirroring `compassIntent.test.js`); `tutor_topic` (mocked `callLLM` + `getTopicDetail` → asserts explanation + `start_check_quiz` action with `beforeScore`); `tutor_result` (mocked attempt + mastery → asserts delta + next-topic offer); proactive-offer hook (weak-topics turn attaches `start_tutoring`); `source:'tutoring'` tagging on the quiz request.
- **iOS:** inline-quiz flow (request → poll → render → per-question feedback → complete → result); decode of `start_tutoring`/`start_check_quiz` actions + the `tutoring_result` card; delta rendering incl. the provisional state.
- The existing quiz/scoring/mastery pipeline is **untouched** → its tests still cover the write.

## Non-goals (explicit)

No new mastery-write path · no plan/objective mutation · no explicit "misconception resolved" write (implicit via mastery/FSRS) · MCQ checks only (text-response questions excluded from check-quizzes via `assessmentType:'recall'`) · quiz-able topics only (not coding skill-axes) · one topic per loop (chain, not batch) · no voice/Android-UI.

## Known gotchas carried from the audit (for planning)

- **Quiz generation is async** (trigger→poll→fetch) — there is no synchronous "generate now" path; the inline card must poll (iOS `V2QuizRequestLoaderSheet` already proves the pattern; we reuse `QuizService`, new UI).
- **Mastery update is async** (post-`completeQuiz` worker) and **readiness is lazy** (recomputed on read) — hence `tutor_result` re-reads mastery after a short delay and degrades gracefully if the write hasn't landed.
- `knowledgeService.updateMastery` does NOT persist — only its wrappers (`updateFromQuizAttempt`) `.save()`. v1 never calls `updateMastery` directly, so this is a non-issue unless that changes.
- `questionCount` is clamped 1–20 server-side; `requestQuiz` on iOS currently hardcodes 10 — the inline card must pass 4.
- Misconceptions have **no resolve API** (they age out over 60 days / FSRS stability grows) — an explicit "resolved" write is net-new and deferred.

## Future hooks (not built here)

- Explicit "misconception resolved" marking after a passing re-check (net-new field/method on `MisconceptionLedger`).
- A spaced-review actionable flow (today `dueConcepts` is surfaced but not actionable) — the result card's "schedule a spaced review" CTA is the natural entry point.
- Multi-topic guided "study plans" (sequence several loops).
