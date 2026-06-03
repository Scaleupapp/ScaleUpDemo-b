# Compass Progress Intelligence — Design Spec

**Date:** 2026-06-03
**Status:** Approved design, ready for implementation planning
**Repos:** `scaleup-backend` (Node/Express/Mongo), `ScaleUpDemo-f` (iOS/SwiftUI). Android (`ScaleUpAndroid`) inherits the server capability for free and renders its own cards when it reaches Compass parity (separate track).

## Goal

Make Compass (the Navigator) the omniscient, real-time companion that **knows the learner's entire journey across every activity type and can reason about it in plain conversation.** Today Compass is a reactive launcher whose own progress context is partly broken; this spec makes it able to answer, with grounded specifics drawn from real data:

- *"Why am I still stuck at 70% when I've done so much?"*
- *"What are my weakest topics — and where did that come from?"*
- *"How did I do on my latest coding assessment / my last interview / the product-management quiz I took?"*
- *"What have I been working on lately?"*

It is the **foundation sub-project** for the larger Compass vision — the Tutoring Loop, proactivity, voice, and multimodal all build on the awareness and the agentic rails this spec establishes.

## Scope & decomposition

The full Compass vision was decomposed into six sub-projects during brainstorming. This is **#1**, the foundation:

| # | Sub-project | Status |
|---|---|---|
| 0 | Remove resume-builder stub | **bundled into THIS spec** (tiny, and it touches the same Compass UI) |
| **1** | **Compass Progress Intelligence** | **THIS spec** |
| 2 | Tutoring Loop (diagnose → micro-explain → check → update mastery/readiness) | next; extends this spec's tools with write-back |
| 3 | Multimodal in-chat (ephemeral photo → explain/quiz) | later |
| 4 | Android Compass parity | later (parallelizable) |
| 5 | Voice-first mode | later (stretch) |

**In scope (THIS spec):** read-only cross-activity progress intelligence in the existing Compass chat; rich answer **cards**; the resume-builder removal; and fixing Compass's stale readiness/mastery context.

**Out of scope (THIS spec):** any mastery/readiness **writes** (that is the Tutoring Loop, #2); new readiness math; voice; multimodal; Android UI; proactive push/notifications.

## Decisions locked during brainstorming

1. **Architecture = always-on snapshot + read-only retrieval tools (agentic).** A compact progress snapshot is injected into Compass's prompt every turn; for deep dives the model calls read-only tools. Chosen over a fat-context blob (token-blowing, can't fetch specific old records) and over a separate Progress endpoint (fragments the single-Compass UX).
2. **Read-only, hard rule.** Every tool only *reads*. Compass cannot mutate the plan, objective, mastery, or readiness in this spec — directly honoring the "don't mess up the user's journey" guardrail. Write-back is the Tutoring Loop's job, built on these same rails.
3. **Numbers come from data; the LLM only phrases, never invents.** Same discipline the existing `coach` mode already enforces ("DO NOT invent stats"). Every figure in an answer traces to the snapshot or a tool result.
4. **Readiness explanation is adaptive and decoupled.** Compass explains *whatever the readiness service currently serves* — a topic-average explanation today, auto-upgrading to the competency-weighted breakdown the moment the readiness-redesign composite flag flips. No new readiness logic here; zero coupling risk with that in-flight initiative.
5. **All six activity types in v1** — quiz, interview, coding (capstone + drill), competition, content consumption, notes — composed from existing aggregators, not re-implemented.
6. **Rich answer cards in v1.** Tool outputs are surfaced to the client as typed cards rendered beneath the narration. Graceful degradation: unknown/zero cards → text only.
7. **Resume-builder removal bundled in.**

---

## Architecture

The whole feature is **additive** — no changes to existing schemas except an additive, optional `cards` array on the Compass message subdocument (the readiness "additive only" rule is respected; `CompassConversation` is not a readiness model).

### 1. `compassProgressService.js` (new — `src/services/v2/`)

The single composition point. It does **not** re-implement analytics; it calls existing services and projects their output into compact shapes.

```
getSnapshot(userId) -> ProgressSnapshot          // the always-on digest (see §2)

// retrieval functions backing the tools (§3) — each returns compact, pre-summarized data:
explainReadiness(userId)            -> ReadinessExplanation
getLatestResult(userId, type)       -> ActivityResult | null
findActivity(userId, type, query)   -> ActivityResult | null
getTopicDetail(userId, topic)       -> TopicDetail | null
listWeakTopics(userId, limit=5)     -> WeakTopic[]
listRecentActivity(userId, limit=8, type?) -> ActivityListItem[]
```

**Sources (reuse, don't reinvent):**

- **Readiness** — reuse the readiness assembly that `GET /api/v2/you/overview` already performs (`readinessService.assemble()` + the `readiness.breakdown` shadow mapping in `src/routes/v2/you.js:136-273`). Extract that assembly into a shared helper if needed so Compass and the You tab can never disagree. *Adaptive:* today this yields `KnowledgeProfile.overallScore` (flat topic-average) + topic-level draggers; when `FEATURE_COMPOSITE_READINESS` is on it yields the competency-weighted breakdown — Compass narrates whichever is served.
- **Mastery** — `KnowledgeProfile.topicMastery[]` (array: `topic` lowercased, `score` 0-100, `level`, `trend`, `scoreHistory[]`, `quizzesTaken`, `lastAssessedAt`) and `topicInterviewMastery` (Map, 0-10). Weak = `score < 60 && quizzesTaken >= 1`; strong = `score >= 75` (match `userContextService` thresholds).
- **Signals** — `userContextService.getUserContext(userId)` for misconceptions, `dueForReview`, cognitive traits, recent tutor topics (already aggregated, 5-min cached).
- **Per-activity latest/detail** — see §3 table for exact models, indexes, and the existing analytics services to reuse (`interviewAnalyticsService`, `competitionService`, `/you/coding-mastery`, `/you/activities`).

**Caching:** in-process Map, ~90s TTL for the snapshot (short, to feel "real-time"); `invalidate(userId)` exported for a future activity-completion hook. Per-record tool fetches are always live.

### 2. The Progress Snapshot (always injected, target ~300-500 tokens)

Built by `getSnapshot`, rendered as natural-language lines into the system prompt (the "Compass always knows where you stand" layer):

- **Readiness:** served value + target (flat 80 today) + trend; top 2-3 draggers from the best-available breakdown.
- **Mastery:** top 3 strong + bottom 3-5 weak topics (score + trend).
- **Cross-activity pulse** (one line each): quizzes (n, avg %), interviews (n, avg, weakest dimension), coding (graded n, avg, skill axes), competitions (best/streak), content (completed, time spent), notes (n).
- **Attention signals:** due-for-review count + top concepts, top misconceptions, plan week x/y + tasks this week, streak.

Every sub-fetch is independently try/caught — a failure omits that line, never fails the turn.

### 3. `compassTools.js` (new — `src/services/v2/`)

Anthropic tool-use schemas + a dispatcher mapping each tool to a `compassProgressService` call. **`userId` is injected server-side from the authenticated request** — the model never supplies it (same ownership pattern as `compassCoderTools`). All read-only; the dispatcher wraps each call so a thrown error becomes `{ error }` returned to the model (never crashes the turn).

| Tool | Backs the question | Source / model (with index) | Returns (compact) |
|---|---|---|---|
| `explain_readiness` | "why am I at 70?" | shared readiness assembly (§1) | score, target, trend, contributors `[{name,score,weight,assessed}]`, top draggers, distance-to-target |
| `get_latest_result(type)` | "how did I do on my latest X?" | per-type latest query (below) | type-discriminated breakdown |
| `find_activity(type, query)` | "how did I do on the PM quiz?" | indexed lookup + fuzzy match | same shape as `get_latest_result` |
| `get_topic_detail(topic)` | "how am I doing on recursion?" | `KnowledgeProfile` + related | score, level, trend, history, related activities, misconceptions, due concepts |
| `list_weak_topics(limit?)` | "what are my weakest topics?" | `topicMastery` sorted | `[{topic,score,trend,assessedBy[]}]` |
| `list_recent_activity(limit?, type?)` | "what have I done lately?" | reuse `/you/activities` `recent[]` builder | `[{type,title,score,date}]` |

**Per-type latest / detail queries (verified against the models):**

- **quiz** — `QuizAttempt.find({userId, status:'completed'}).sort({completedAt:-1})` (index `{userId,completedAt:-1}`) → `score{percentage,correct,total}`, `topicBreakdown[]`, `competencyBreakdown[]`, `analysis{strengths,weaknesses,missedConcepts,comparisonToPrevious}`. By topic: `Quiz.find({userId, topic})` (index `{userId,topic}`; topic stored lowercased).
- **interview** — `InterviewSession.find({userId, status:{$in:['completed','evaluated']}}).sort({completedAt:-1})` → `evaluation{overallScore, communication/content/structure/confidence {score,feedback}, overallStrengths[], overallImprovements[], perQuestion[]}`. Aggregate via `interviewAnalyticsService.getAnalytics`.
- **coding** — `CapstoneSession.find({user_id, status:'graded'}).sort({graded_at:-1})` (index `{user_id,status,graded_at:-1}`) → `result{overall_score, dimension_scores(6), dimension_feedback{why,to_improve}, evidence_notes, strengths[], gaps[], test_summary}`. Drills: `DrillAttempt.grade`. Aggregate via `GET /you/coding-mastery` + `MetaSkillMastery` axes. Title comes from the joined `ArtifactBundle.brief` first line.
- **competition** — `competitionService.getCompetitionHistory` / `getChallengeResults` → `rawScore, handicappedScore, rank, percentile, isPersonalBest`. Note: `ChallengeAttempt` has **no `{userId, completedAt}` index** — "latest" sort scans the user's attempts (cheap per-user; acceptable, flag for a possible index in planning).
- **content** — `ContentProgress.find({userId, isCompleted:true}).sort({completedAt:-1})` (index exists) → `percentageCompleted, totalTimeSpent`; topics via joined `Content.topics/domain`.
- **notes** — `Content{contentType:'notes'}` + `NoteRequest` counts; creation/consumption, not scored.

**Topic normalization:** route topic queries through `topicTaxonomyService.canonicalize`, and bridge the inconsistent key conventions (quiz/content lowercased free-form vs `UserObjective` Title-Case competency names) using the existing fuzzy matcher pattern in `competencyMasteryService.matchTopicMastery`. **Coding has no topic taxonomy** — it lives on the `role_track`/skill-axes plane and is reported as its own dimension, never joined on topic.

### 4. Orchestrator changes (`src/services/v2/compassOrchestrator.js`)

- **Bug fix (core to this spec):** rewrite `buildUserContext` to read the real readiness number via the shared readiness assembly and mastery via `KnowledgeProfile.topicMastery` — replacing the current reads of `plan.readinessScore` (always `undefined`; the `Plan` schema has no such field) and the legacy `knowledge.topicProfiles` map. Today Compass does not reliably know the learner's readiness or mastery; this fixes it.
- **Tool-use loop:** enable tools on the `conversation` and `coach` modes. Build the prompt = persona + **snapshot** + tool defs + the hard rule *"NEVER state a number or result you did not get from the snapshot or a tool."* Then run the standard Anthropic loop, mirroring the proven in-house `compassCoder.turn()` pattern: call → on `stop_reason === 'tool_use'`, dispatch each tool via `compassTools`, append `tool_result`s, repeat. Cap `COMPASS_MAX_TOOL_ITERATIONS = 5`. The model self-selects tools; snapshot-only answers make no tool calls.

### 5. The card system (response extension)

Cards **are the tool outputs surfaced to the client** — not a second data path.

- **Response envelope:** `POST /api/v2/compass` gains an additive `data.cards: [{ type, payload }]`. Text reply stays in `data.reply`/`message`. Contract change → update `openapi.yaml` + regenerate the `APICompass…` Swift models + add contract-test coverage.
- **Card types (v1), mapped 1:1 to tools:**
  - `readiness_explanation` ← `explain_readiness`
  - `activity_result` ← `get_latest_result` / `find_activity` (type-discriminated: quiz | interview | coding | competition)
  - `topic_detail` ← `get_topic_detail`
  - `weak_topics` ← `list_weak_topics`
  - `recent_activity` ← `list_recent_activity`
- **Assembly:** after the tool loop, collect the structured outputs of the tools the model invoked this turn, project each to its card payload, **dedupe by type, cap at 2**, attach to the response.
- **Persistence:** store `cards` on the persisted assistant message (additive optional field on `compassMessageSchema`) so the Compass history view (`GET /api/v2/you/compass/history`) can re-render them.

### 6. iOS changes (`ScaleUpDemo-f`)

- **Decode** `data.cards` permissively in `CompassResponseEnvelope` (forward-compatible; unknown `type` decodes to an ignorable case). Extend the chat message model with optional `cards`.
- **Render** card views beneath the assistant text bubble in `MessageView` (`Features/V2/Compass/V2CompassView.swift`), styled to the existing gold/surface design system: `CompassReadinessCard`, `CompassActivityResultCard`, `CompassTopicDetailCard`, `CompassWeakTopicsCard`, `CompassRecentActivityCard`.
- **Graceful degradation:** zero or unknown cards → text only. (Also neatly sidesteps the chat's current no-markdown limitation.)
- No change to the request path or the `POST /compass` request body.

### 7. Resume-builder removal (#0, bundled)

- **iOS:** delete `Features/V2/Compass/V2ResumeHomeView.swift`; remove the `.resume` case from `CompassHomeRoute` + its mapping in `CompassViewModel.swift`; remove **"Build my resume"** from the quick-actions strip (`CompassQuickAction.all`) and the **"📄 Build my resume"** default suggestion chip in `V2CompassView.swift`; drop the `presentedHome == .resume` sheet branch.
- **Backend:** the orchestrator emits no resume action today; a grep-and-remove pass to confirm (expected zero change).

---

## Data flow (a question end-to-end)

1. User types a question in Compass chat → `POST /api/v2/compass` (`mode: conversation` or `coach`), unchanged request body.
2. Orchestrator builds the prompt: persona + `getSnapshot(userId)` lines + tool defs + the never-invent rule.
3. Anthropic call. If `tool_use`: dispatch read-only tool(s) via `compassTools` (userId server-scoped) → append `tool_result`(s) → loop (cap 5).
4. Final narration text + `cards` (projected from invoked tools, deduped, cap 2) → persisted to `CompassConversation` → token usage reconciled against the existing Compass daily budget.
5. Response `{ success, data: { reply, followups, cards } }` → iOS renders the text bubble + card views; unknown cards ignored.

## Cost & budget

Reuse the **existing Compass Redis daily token budget** in `compassOrchestrator` (`DAILY_TOKEN_CAP_FREE = 50_000`; the Pro cap is defined-but-unwired and stays as-is). Reserve extra headroom for tool loops (the `compassCoder` `est + maxTokens*2` pattern). Over cap → existing capped copy. The 5-iteration cap bounds worst-case spend per turn. Model unchanged: `COMPASS_MODEL = claude-sonnet-4-20250514`.

## Error handling & resilience

- **Snapshot:** best-effort per line — any sub-fetch failure omits that line, never fails the turn.
- **Tools:** dispatcher converts any thrown error to `{ error }` returned to the model, which then says "I couldn't pull that up" rather than crashing.
- **Model call failure:** retry once with tools disabled (snapshot-only answer); then fall back to the existing conversation error copy.
- **Empty/new user:** snapshot and tools return honest "no data yet" shapes; Compass encourages a first activity instead of inventing stats.

## Testing

- **Unit:** snapshot builder with fixtures per activity type + the empty/new-user case; each retrieval function; **userId-scoping test** (a tool cannot return another user's data); topic fuzzy-match bridging (lowercased ↔ Title-Case ↔ kebab).
- **"Never invent" guard:** prompt-assembly test asserting no stray stats leak into the base prompt beyond the snapshot; integration test that "how did I do on my last interview" invokes `get_latest_result('interview')`.
- **Tool loop:** mock Anthropic `tool_use → tool_result → final` round-trip honoring the iteration cap.
- **Cards:** serialization per type; the OpenAPI contract test for the new `cards` field; iOS decode test for unknown card type → ignored.
- Reuse the existing `compassIntent` / `compassCoder` test patterns and `openapi-contract.test.js`.

## Non-goals (explicit)

Read-only only — no mastery/readiness writes (Tutoring Loop, #2). No new readiness math (consume `readinessService` as-is). No voice, multimodal, Android UI, or proactive push. Rich cards are in; everything beyond the five card types above is later polish.

## Known gotchas carried from the data-model audit (for planning)

- Compass's current `buildUserContext` / `computeActivity` read stale legacy fields — **fix as part of §4**, and audit `routes/v2/insights.js` which shares the legacy `topicProfiles` read.
- Topic keys are inconsistent across collections; always normalize and use the fuzzy matcher. Coding cannot be joined on topic.
- `ChallengeAttempt` lacks a `{userId, completedAt}` index; "latest competition" is a per-user scan today.
- The shared readiness assembly should be the *single* source for both `/you/overview` and Compass to avoid number drift.

## Future hooks (not built here)

`get_topic_detail` is the deliberate entry point for the **Tutoring Loop (#2)**: that spec adds *write* tools (e.g. `generate_check_quiz`, and a mastery write-back through `knowledgeService.updateMastery` + `profile.save()`, the established idempotent pattern) on top of these read rails.
