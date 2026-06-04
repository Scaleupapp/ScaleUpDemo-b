# Compass Tutoring Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Compass close the learning loop — detect/offer tutoring on a weak topic, teach it (grounded in the learner's real misconceptions), run a short inline check-quiz that reuses the existing quiz→mastery pipeline, and show the before→after mastery delta — all inside Compass chat.

**Architecture:** Thin orchestration over existing machinery. Backend adds a `request_tutoring` intent + a proactive-offer hook + two LLM modes (`tutor_topic`, `tutor_result`) + a `tutoring_result` card; the check reuses `POST /api/v1/quizzes/request` and the existing take/score/mastery pipeline (no new write path). iOS adds an offer card, a `CompassInlineQuizModel`/`CompassInlineQuizCard` (the one real new component) that drives the existing `QuizService`, and a result card. Feedback is **end-of-check review** (correctAnswer/explanation are available post-completion).

**Tech Stack:** Node/Express/Mongo, Anthropic (Claude Sonnet 4) via the existing `callLLM`; `node --test --test-force-exit <file>` for backend tests. SwiftUI; xcodegen (`/opt/homebrew/bin/xcodegen generate`), scheme `ScaleUp`, simulator `iPhone 16`.

**Spec:** `docs/superpowers/specs/2026-06-04-compass-tutoring-loop-design.md`

---

## Shared contract (keep names identical across tasks)

**Backend → client action/card shapes** (carried on the existing `output.suggested_action` + `output.cards`):
```
suggested_action (one of):
  { type: 'start_tutoring',   topic: String, score: Number|null }
  { type: 'start_check_quiz', topic: String, question_count: Number, before_score: Number|null }

tutoring_result card:
  { type: 'tutoring_result', payload: { topic, checkScore: Number|null, beforeScore: Number|null, afterScore: Number|null, delta: Number|null } }
```
**New Compass request modes** (`POST /api/v2/compass`):
```
{ mode: 'tutor_topic',  payload: { topic } }
{ mode: 'tutor_result', payload: { topic, attemptId, beforeScore } }
```
**Check-quiz request:** reuse `POST /api/v1/quizzes/request` with `{ topic, questionCount: 4, assessmentType: 'recall', source: 'tutoring' }`.

**iOS:** `CompassSuggestedAction` gains optional `topic, score, questionCount, beforeScore`. New Codable card `tutoring_result`. New `CompassInlineQuizModel` + `CompassInlineQuizCard`.

---

## Phase 1 — Backend

### Task 1: `request_tutoring` intent detector

**Files:**
- Create: `src/services/v2/tutoringIntent.js`
- Create: `src/test/v2/tutoringIntent.test.js`

- [ ] **Step 1: Write the failing test** (mirrors `src/test/coding/compassIntent.test.js`)

```js
// src/test/v2/tutoringIntent.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const INTENT = path.resolve(__dirname, '../../services/v2/tutoringIntent.js');
const LLM_ROUTER = path.resolve(__dirname, '../../coding/services/llmRouter.js');
const PARSE = path.resolve(__dirname, '../../coding/services/drillGrader/parseLLMJson.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[INTENT]; return require(INTENT); }

test('maybeIsTutoringRequest: true for "help me get better at recursion"', () => {
  const { maybeIsTutoringRequest } = load();
  assert.equal(maybeIsTutoringRequest('help me get better at recursion'), true);
});
test('maybeIsTutoringRequest: true for "tutor me on dynamic programming"', () => {
  const { maybeIsTutoringRequest } = load();
  assert.equal(maybeIsTutoringRequest('tutor me on dynamic programming'), true);
});
test('maybeIsTutoringRequest: false for a plain content question', () => {
  const { maybeIsTutoringRequest } = load();
  assert.equal(maybeIsTutoringRequest('what is recursion?'), false);
});
test('detectTutoringRequest: returns start_tutoring with topic (stub LLM)', async () => {
  stub(LLM_ROUTER, { llmCall: async () => ({ content: '{"is_tutoring_request":true,"topic":"recursion"}' }) });
  stub(PARSE, { parseLLMJson: (c) => JSON.parse(c) });
  const { detectTutoringRequest } = load();
  const r = await detectTutoringRequest('help me get better at recursion');
  assert.equal(r.type, 'start_tutoring');
  assert.equal(r.topic, 'recursion');
});
test('detectTutoringRequest: null when LLM says not a tutoring request', async () => {
  stub(LLM_ROUTER, { llmCall: async () => ({ content: '{"is_tutoring_request":false}' }) });
  stub(PARSE, { parseLLMJson: (c) => JSON.parse(c) });
  const { detectTutoringRequest } = load();
  assert.equal(await detectTutoringRequest('help me get better at life'), null);
});
test('detectTutoringRequest: null (no throw) on LLM error', async () => {
  stub(LLM_ROUTER, { llmCall: async () => { throw new Error('net'); } });
  const { detectTutoringRequest } = load();
  assert.equal(await detectTutoringRequest('tutor me on arrays'), null);
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module '.../tutoringIntent.js'`):
`node --test --test-force-exit src/test/v2/tutoringIntent.test.js`

- [ ] **Step 3: Implement** (mirrors `compassIntent.js`)

```js
// src/services/v2/tutoringIntent.js
'use strict';

/**
 * Detects when a Compass user is asking to be TUTORED on a topic (vs a coding
 * drill — see compassIntent.js). Two-stage: keyword pre-filter → cheap Haiku
 * classifier. Returns a `start_tutoring` action or null. Never throws.
 */

const TUTORING_REQUEST_KEYWORDS = [
  'tutor me', 'help me get better', 'help me improve', 'teach me',
  'get better at', 'improve at', 'improve on', 'help me understand',
  'help me with', 'explain and quiz', 'work on my', 'i keep messing up',
  'i keep getting', "i'm weak", 'im weak', 'struggle with',
];

function maybeIsTutoringRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return TUTORING_REQUEST_KEYWORDS.some((kw) => lower.includes(kw));
}

async function detectTutoringRequest(userMessage) {
  if (!maybeIsTutoringRequest(userMessage)) return null;
  const system = `You are an intent classifier for a learning platform. The user is chatting with their AI tutor. Determine if they are asking to be tutored/coached on a specific topic so they can improve at it.

If they ARE asking to be tutored on a topic, return JSON:
{ "is_tutoring_request": true, "topic": "<the topic, short, lowercase>" }

If they are NOT (general chat, a content question, asking for a coding drill, vague life advice), return:
{ "is_tutoring_request": false }

Return STRICT JSON only. No prose. No markdown fences.`;
  try {
    const { llmCall } = require('../../coding/services/llmRouter');
    const res = await llmCall({ taskId: 'drill_grade_prompt', system, messages: [{ role: 'user', content: userMessage }] });
    const { parseLLMJson } = require('../../coding/services/drillGrader/parseLLMJson');
    const parsed = parseLLMJson(res.content);
    if (!parsed || !parsed.is_tutoring_request) return null;
    return { type: 'start_tutoring', topic: (parsed.topic || '').toString().trim().toLowerCase() || null, score: null };
  } catch (e) {
    console.error('[tutoringIntent.detectTutoringRequest]', e.message);
    return null;
  }
}

module.exports = { detectTutoringRequest, maybeIsTutoringRequest };
```

- [ ] **Step 4: Run → PASS** (6 tests): `node --test --test-force-exit src/test/v2/tutoringIntent.test.js`
- [ ] **Step 5: Commit**
```bash
git add src/services/v2/tutoringIntent.js src/test/v2/tutoringIntent.test.js
git commit -m "feat(compass): request_tutoring intent detector"
```

---

### Task 2: Wire tutoring intent + proactive-offer hook into the orchestrator

**Files:**
- Modify: `src/services/v2/compassOrchestrator.js` (require + the intent block + a proactive-offer block)
- Create: `src/test/v2/compassOrchestrator.tutoringOffer.test.js`

The current intent block (search for `detectDrillRequest` near the end of `handle()`) sets `response.output.suggested_action` for drills. We (a) check tutoring FIRST (drill is the fallback), and (b) add a proactive offer: if no action was set and the turn produced a `weak_topics` or `readiness_explanation` card, offer `start_tutoring` for the top weak topic.

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassOrchestrator.tutoringOffer.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }

test('attachProactiveTutoringOffer: offers start_tutoring from a weak_topics card', () => {
  const orch = load();
  const response = { mode: 'conversation', output: { reply: 'x', cards: [
    { type: 'weak_topics', payload: { topics: [{ topic: 'recursion', score: 35 }, { topic: 'graphs', score: 50 }] } },
  ] } };
  orch.attachProactiveTutoringOffer(response);
  assert.equal(response.output.suggested_action.type, 'start_tutoring');
  assert.equal(response.output.suggested_action.topic, 'recursion');
  assert.equal(response.output.suggested_action.score, 35);
});

test('attachProactiveTutoringOffer: no-op when an action already exists', () => {
  const orch = load();
  const response = { mode: 'conversation', output: { reply: 'x', suggested_action: { type: 'request_drill' }, cards: [
    { type: 'weak_topics', payload: { topics: [{ topic: 'recursion', score: 35 }] } },
  ] } };
  orch.attachProactiveTutoringOffer(response);
  assert.equal(response.output.suggested_action.type, 'request_drill');
});
```

- [ ] **Step 2: Run → FAIL** (`attachProactiveTutoringOffer is not a function`):
`node --test --test-force-exit src/test/v2/compassOrchestrator.tutoringOffer.test.js`

- [ ] **Step 3: Implement**

Add the require near the other v2 requires at the top of `compassOrchestrator.js`:
```js
const { detectTutoringRequest } = require('./tutoringIntent');
```

Replace the existing drill-intent block (the `try { const action = await detectDrillRequest(userMessage); ... }` inside `handle()`) with tutoring-first + drill-fallback:
```js
  if (
    INTENT_ELIGIBLE_MODES.includes(mode) && userMessage &&
    response && response.output && !response.output.suggested_action
  ) {
    try {
      const tutoring = await detectTutoringRequest(userMessage);
      if (tutoring) {
        response.output.suggested_action = tutoring;
      } else {
        const action = await detectDrillRequest(userMessage);
        if (action) response.output.suggested_action = action;
      }
    } catch (e) {
      console.error('[compass intent detection]', e.message);
    }
  }

  // Proactive tutoring offer: if a turn surfaced weak topics and nothing else
  // claimed the action slot, offer to tutor the top weak topic.
  attachProactiveTutoringOffer(response);
```

Add this exported helper (place it near `handle`):
```js
/**
 * If the response carries a weak_topics or readiness_explanation card and no
 * suggested_action is set, attach a start_tutoring offer for the top weak topic.
 * Best-effort, pure, never throws.
 */
function attachProactiveTutoringOffer(response) {
  try {
    if (!response || !response.output || response.output.suggested_action) return;
    const cards = response.output.cards || [];
    const weak = cards.find((c) => c.type === 'weak_topics');
    if (weak && Array.isArray(weak.payload?.topics) && weak.payload.topics.length) {
      const t = weak.payload.topics[0];
      response.output.suggested_action = { type: 'start_tutoring', topic: t.topic, score: t.score ?? null };
      return;
    }
    const readiness = cards.find((c) => c.type === 'readiness_explanation');
    if (readiness && Array.isArray(readiness.payload?.topDraggers) && readiness.payload.topDraggers.length) {
      const d = readiness.payload.topDraggers[0];
      response.output.suggested_action = { type: 'start_tutoring', topic: d.name, score: d.score ?? null };
    }
  } catch (_) {}
}
```

Add `attachProactiveTutoringOffer` to the module exports object.

- [ ] **Step 4: Run → PASS** (2 tests). Also run the full v2 suite to confirm no regression: `node --test --test-force-exit src/test/v2/*.test.js`
- [ ] **Step 5: Commit**
```bash
git add src/services/v2/compassOrchestrator.js src/test/v2/compassOrchestrator.tutoringOffer.test.js
git commit -m "feat(compass): tutoring-first intent + proactive tutoring offer"
```

---

### Task 3: `tutor_topic` mode (the explanation)

**Files:**
- Modify: `src/services/v2/compassOrchestrator.js` (add `tutorTopic` + switch case)
- Create: `src/test/v2/compassOrchestrator.tutorTopic.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassOrchestrator.tutorTopic.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const ANTHROPIC = path.resolve(__dirname, '../../config/anthropic.js');
const REDIS = path.resolve(__dirname, '../../config/redis.js');
const PROGRESS = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const CONV = path.resolve(__dirname, '../../models/CompassConversation.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }
function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async () => 0, expire: async () => 1, get: async () => '0' }; }

test('tutorTopic: explains the topic grounded in misconceptions + offers a check', async () => {
  stub(REDIS, fakeRedis());
  stub(CONV, {});
  stub(PROGRESS, { getTopicDetail: async () => ({ topic: 'recursion', score: 35, level: 'beginner', trend: 'declining', misconceptions: [{ tag: 'base_case', explanation: 'forgets the base case' }], dueConcepts: [] }) });
  stub(ANTHROPIC, { messages: { create: async ({ system }) => {
    assert.match(system, /recursion/);
    assert.match(system, /base_case|forgets the base case/);
    return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Every recursion needs a base case. Example: factorial...' }] };
  } } });
  const orch = load();
  const res = await orch.handle({ userId: 'u1', mode: 'tutor_topic', payload: { topic: 'recursion' } });
  assert.match(res.output.reply, /base case/i);
  assert.equal(res.output.cards[0].type, 'topic_detail');
  assert.equal(res.output.suggested_action.type, 'start_check_quiz');
  assert.equal(res.output.suggested_action.topic, 'recursion');
  assert.equal(res.output.suggested_action.before_score, 35);
});
```
> Note: `handle()` also builds user context (User/UserObjective/Plan/KnowledgeProfile/readinessService). Stub those the same way `compassOrchestrator.context.test.js` does (copy its stub block for User, UserObjective, Plan, KnowledgeProfile, userContextService, readinessService) so `buildUserContext` resolves. Include those stubs at the top of this test.

- [ ] **Step 2: Run → FAIL** (unknown mode / `tutorTopic` undefined):
`node --test --test-force-exit src/test/v2/compassOrchestrator.tutorTopic.test.js`

- [ ] **Step 3: Implement**

Add the handler (near `conversation`):
```js
async function tutorTopic({ systemPrompt, userId, topic }) {
  if (!topic || typeof topic !== 'string') {
    return { mode: 'tutor_topic', output: { reply: 'Which topic would you like help with?', followups: [], cards: [] } };
  }
  const detail = await compassProgress.getTopicDetail(userId, topic).catch(() => null);
  const misc = (detail?.misconceptions || []).map((m) => `${m.tag}: ${m.explanation}`).join('; ');
  const tutorPrompt = systemPrompt +
    `\n\n[Mode: tutor_topic] You are tutoring the learner on "${topic}". They are ${detail?.level || 'an unknown level'} (${detail?.score ?? '—'}%).` +
    (misc ? ` Their recurring misconceptions: ${misc}.` : '') +
    ` Teach concisely (4-8 sentences) with 1-2 short worked examples that DIRECTLY fix those misconceptions. Don't dump everything about the topic. End by inviting a quick check. Do not include any JSON block.`;
  const llmResult = await callLLM({ userId, systemPrompt: tutorPrompt, userPrompt: `Help me understand ${topic}.`, maxTokens: COMPASS_MAX_TOKENS });
  if (llmResult.capped) {
    const reply = "You've hit today's free Compass usage. Try again tomorrow or upgrade for higher limits.";
    await appendToThread(userId, 'assistant', reply, { mode: 'tutor_topic' });
    return { mode: 'tutor_topic', output: { reply, followups: [], cards: [] } };
  }
  const reply = llmResult.text || `Let's work on ${topic}. Ready for a quick check?`;
  const cards = detail ? [{ type: 'topic_detail', payload: detail }] : [];
  const suggested_action = { type: 'start_check_quiz', topic, question_count: 4, before_score: detail?.score ?? null };
  await appendToThread(userId, 'assistant', reply, { mode: 'tutor_topic', cards, tokensIn: llmResult.tokensIn, tokensOut: llmResult.tokensOut });
  return { mode: 'tutor_topic', output: { reply, followups: [], cards, suggested_action } };
}
```
Add to the `handle()` switch (before `default`):
```js
    case 'tutor_topic':
      response = await tutorTopic({ systemPrompt, userId, topic: payload.topic });
      break;
```

- [ ] **Step 4: Run → PASS.** Then full v2 suite: `node --test --test-force-exit src/test/v2/*.test.js`
- [ ] **Step 5: Commit**
```bash
git add src/services/v2/compassOrchestrator.js src/test/v2/compassOrchestrator.tutorTopic.test.js
git commit -m "feat(compass): tutor_topic mode (misconception-grounded explanation + check offer)"
```

---

### Task 4: `tutor_result` mode (reflection + mastery delta + chain)

**Files:**
- Modify: `src/services/v2/compassOrchestrator.js` (add `tutorResult` + switch case)
- Create: `src/test/v2/compassOrchestrator.tutorResult.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassOrchestrator.tutorResult.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const ANTHROPIC = path.resolve(__dirname, '../../config/anthropic.js');
const REDIS = path.resolve(__dirname, '../../config/redis.js');
const PROGRESS = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const QA = path.resolve(__dirname, '../../models/QuizAttempt.js');
const CONV = path.resolve(__dirname, '../../models/CompassConversation.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }
function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async () => 0, expire: async () => 1, get: async () => '0' }; }

test('tutorResult: returns check score, mastery delta, and a next-topic offer', async () => {
  // (include the same buildUserContext stubs as the tutorTopic test)
  stub(REDIS, fakeRedis());
  stub(CONV, {});
  stub(QA, { findOne: () => ({ lean: async () => ({ score: { percentage: 75 } }) }) });
  stub(PROGRESS, {
    getTopicDetail: async () => ({ topic: 'recursion', score: 52 }),
    listWeakTopics: async () => [{ topic: 'recursion', score: 52 }, { topic: 'graphs', score: 41 }],
  });
  stub(ANTHROPIC, { messages: { create: async () => ({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Nice jump on recursion — revisit recursion vs iteration.' }] }) } });
  const orch = load();
  const res = await orch.handle({ userId: 'u1', mode: 'tutor_result', payload: { topic: 'recursion', attemptId: 'a1', beforeScore: 35 } });
  const card = res.output.cards.find((c) => c.type === 'tutoring_result');
  assert.equal(card.payload.checkScore, 75);
  assert.equal(card.payload.beforeScore, 35);
  assert.equal(card.payload.afterScore, 52);
  assert.equal(card.payload.delta, 17);
  assert.equal(res.output.suggested_action.type, 'start_tutoring');
  assert.equal(res.output.suggested_action.topic, 'graphs'); // next weak topic (not the one just done)
});
```

- [ ] **Step 2: Run → FAIL.** `node --test --test-force-exit src/test/v2/compassOrchestrator.tutorResult.test.js`

- [ ] **Step 3: Implement**

```js
async function tutorResult({ systemPrompt, userId, topic, attemptId, beforeScore }) {
  const QuizAttempt = require('../../models/QuizAttempt');
  let checkScore = null;
  try {
    const attempt = await QuizAttempt.findOne({ _id: attemptId, userId }).lean();
    checkScore = attempt?.score?.percentage ?? null;
  } catch (_) {}
  const detail = await compassProgress.getTopicDetail(userId, topic).catch(() => null);
  const afterScore = detail?.score ?? null;
  const before = typeof beforeScore === 'number' ? beforeScore : null;
  const delta = (typeof afterScore === 'number' && before != null) ? Math.round(afterScore - before) : null;

  let nextTopic = null;
  try {
    const weak = await compassProgress.listWeakTopics(userId, 5);
    nextTopic = (weak.find((w) => w.topic !== topic) || weak[0])?.topic || null;
  } catch (_) {}

  const resultPrompt = systemPrompt +
    `\n\n[Mode: tutor_result] The learner just took a ${checkScore ?? '—'}% check on "${topic}". Their mastery is now ${afterScore ?? '—'}% (was ${before ?? '—'}%). In 2-3 warm sentences, reflect on how they did and what to revisit. Ground every number in the data above; DO NOT invent stats. No JSON block.`;
  const llmResult = await callLLM({ userId, systemPrompt: resultPrompt, userPrompt: `How did I do on the ${topic} check?`, maxTokens: 300 });
  const reply = llmResult.text || `You scored ${checkScore ?? '—'}% on the ${topic} check.`;
  const card = { type: 'tutoring_result', payload: { topic, checkScore, beforeScore: before, afterScore, delta } };
  await appendToThread(userId, 'assistant', reply, { mode: 'tutor_result', cards: [card], tokensIn: llmResult.tokensIn, tokensOut: llmResult.tokensOut });
  const output = { reply, followups: [], cards: [card] };
  if (nextTopic) output.suggested_action = { type: 'start_tutoring', topic: nextTopic, score: null };
  return { mode: 'tutor_result', output };
}
```
Add to the `handle()` switch:
```js
    case 'tutor_result':
      response = await tutorResult({ systemPrompt, userId, topic: payload.topic, attemptId: payload.attemptId, beforeScore: payload.beforeScore });
      break;
```

- [ ] **Step 4: Run → PASS.** Then full v2 suite.
- [ ] **Step 5: Commit**
```bash
git add src/services/v2/compassOrchestrator.js src/test/v2/compassOrchestrator.tutorResult.test.js
git commit -m "feat(compass): tutor_result mode (mastery delta + chain to next weak topic)"
```

---

### Task 5: OpenAPI — `tutoring_result` card + new modes

**Files:**
- Modify: `openapi.yaml`
- Create: `src/test/v2/compassTutoringOpenapi.test.js`

- [ ] **Step 1: Write the failing test**
```js
// src/test/v2/compassTutoringOpenapi.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
test('openapi.yaml documents the tutoring_result card type and the tutor modes', () => {
  const yaml = fs.readFileSync(path.resolve(__dirname, '../../../openapi.yaml'), 'utf8');
  assert.ok(yaml.includes('tutoring_result'), 'CompassCard enum should include tutoring_result');
  assert.ok(yaml.includes('tutor_topic') && yaml.includes('tutor_result'), 'compass mode enum should include tutor_topic/tutor_result');
});
```
- [ ] **Step 2: Run → FAIL.** `node --test --test-force-exit src/test/v2/compassTutoringOpenapi.test.js`
- [ ] **Step 3: Implement** — in `openapi.yaml`: add `tutoring_result` to the `CompassCard` schema `type` enum (the 5 existing values); add `tutor_topic` and `tutor_result` to the `mode` enum on the `POST /api/v2/compass` request body (added in the earlier OpenAPI backfill). Keep the response `output` permissive (`additionalProperties: true`) — it already documents `suggested_action`/`cards`.
- [ ] **Step 4: Run → PASS.** Then the existing contract test: `node --test --test-force-exit src/test/openapi-contract.test.js`
- [ ] **Step 5: Commit**
```bash
git add openapi.yaml src/test/v2/compassTutoringOpenapi.test.js
git commit -m "docs(compass): OpenAPI tutoring_result card + tutor modes"
```

## Phase 2 — iOS (repo: `ScaleUpDemo-f`)

> After adding Swift files run `/opt/homebrew/bin/xcodegen generate`. Build: `xcodebuild build -scheme ScaleUp -destination 'platform=iOS Simulator,name=iPhone 16' -configuration Debug -quiet`. New decode types must be `Codable` (the V2 API client constrains response models to `Codable`).

### Task 6: Decode the tutoring actions + render the offer / check CTA cards

**Files:**
- Modify: `ScaleUp/Features/V2/Compass/CompassViewModel.swift` (`CompassSuggestedAction` struct + add `startTutoring(topic:)` send method)
- Modify: `ScaleUp/Features/V2/Compass/V2CompassView.swift` (`MessageView` — render `start_tutoring` / `start_check_quiz` cards; dispatch on tap)

- [ ] **Step 1: Extend `CompassSuggestedAction`** in `CompassViewModel.swift` (it currently has `type, drillSubtype, difficulty, topicHint`). Add optional tutoring fields:
```swift
struct CompassSuggestedAction: Codable, Sendable {
    let type: String              // "request_drill" | "start_tutoring" | "start_check_quiz"
    let drillSubtype: String?
    let difficulty: String?
    let topicHint: String?
    // tutoring
    let topic: String?
    let score: Double?
    let questionCount: Int?
    let beforeScore: Double?

    enum CodingKeys: String, CodingKey {
        case type
        case drillSubtype = "drill_subtype"
        case difficulty
        case topicHint = "topic_hint"
        case topic
        case score
        case questionCount = "question_count"
        case beforeScore = "before_score"
    }
}
```

- [ ] **Step 2: Add a `startTutoring` send method** to `CompassViewModel`, mirroring the existing conversation-mode POST (find `callConversation`/`callGreeting` and copy the `V2APIClient.shared.post("/compass", ...)` + `CompassResponseEnvelope` decode + message-append pattern). It sends `{ mode: "tutor_topic", payload: { topic } }`, appends the assistant reply with its `cards` and `suggestedAction` (the `start_check_quiz` CTA):
```swift
func startTutoring(topic: String) async {
    isWaitingForReply = true
    defer { isWaitingForReply = false }
    do {
        let resp: V2APIResponse<CompassResponseEnvelope> = try await V2APIClient.shared.post(
            "/compass", body: CompassRequest(mode: "tutor_topic", payload: CompassPayload(topic: topic))
        )
        let out = resp.data.output
        messages.append(.init(role: .compass, text: out.reply ?? "Let's work on \(topic).",
                              suggestedAction: out.suggestedAction, cards: out.cards ?? []))
    } catch {
        messages.append(.init(role: .compass, text: "I couldn't start that just now — try again?"))
    }
}
```
> Match the EXACT `CompassRequest`/`CompassPayload`/`V2APIResponse`/`post` shapes already in the file (the file already posts other modes — copy that call site). Add `topic` to `CompassPayload` if not present.

- [ ] **Step 3: Render the cards + dispatch** in `V2CompassView.swift` `MessageView`. The assistant branch currently renders `suggestedActionCard(action)` only when `action.type == "request_drill"` (around line 660). Extend it:
```swift
                    if let action = message.suggestedAction {
                        switch action.type {
                        case "request_drill":     suggestedActionCard(action)
                        case "start_tutoring":    tutoringOfferCard(action)
                        case "start_check_quiz":  checkQuizCTACard(action)
                        default: EmptyView()
                        }
                    }
```
Add the two new card builders (mirror `suggestedActionCard`'s gold styling), wired to the view model:
```swift
    private func tutoringOfferCard(_ action: CompassSuggestedAction) -> some View {
        let topic = action.topic ?? "this topic"
        let scoreText = action.score.map { " — \(Int($0.rounded()))%" } ?? ""
        return tutoringCardShell(icon: "target", title: "Improve: \(topic.capitalized)\(scoreText)", cta: "Start") {
            Task { await vm.startTutoring(topic: topic) }
        }
    }
    private func checkQuizCTACard(_ action: CompassSuggestedAction) -> some View {
        return tutoringCardShell(icon: "checkmark.circle", title: "Ready for a quick check?", cta: "Start check") {
            vm.startInlineCheck(topic: action.topic ?? "", questionCount: action.questionCount ?? 4, beforeScore: action.beforeScore)
        }
    }
```
(Provide a small `tutoringCardShell(icon:title:cta:onTap:)` helper styled like `suggestedActionCard` — gold border, a title row, and a gold capsule button calling `onTap`.) `vm.startInlineCheck(...)` is added in Task 8.

- [ ] **Step 4: Build** (`xcodegen generate` + `xcodebuild build …`). Expected: BUILD SUCCEEDED (note: `startInlineCheck` won't exist until Task 8 — stub it as an empty `func startInlineCheck(topic: String, questionCount: Int, beforeScore: Double?) {}` on the view model for now so this task builds, then fill it in Task 8).
- [ ] **Step 5: Commit**
```bash
git add ScaleUp/Features/V2/Compass/CompassViewModel.swift ScaleUp/Features/V2/Compass/V2CompassView.swift ScaleUp.xcodeproj
git commit -m "feat(compass/ios): decode tutoring actions + offer/check CTA cards"
```

---

### Task 7: `CompassInlineQuizModel` — the inline check lifecycle

**Files:**
- Create: `ScaleUp/Features/V2/Compass/CompassInlineQuizModel.swift`

Mirrors `QuizSessionViewModel` (`Features/Quiz/ViewModels/QuizSessionViewModel.swift`) but inline, MCQ-only, end-of-check review. Uses `QuizService` (`requestQuiz`/`checkTriggerStatus`/`fetchQuiz`/`startQuiz`/`submitAnswer`/`completeQuiz`) and the `Quiz`/`QuizQuestion`/`QuizOption` models (`ScaleUp/Models/Quiz.swift`: `Quiz.questions:[QuizQuestion]`, `QuizQuestion.questionText/options/correctAnswer?/explanation?`, `QuizOption.label/text`).

- [ ] **Step 1: Implement**
```swift
// ScaleUp/Features/V2/Compass/CompassInlineQuizModel.swift
import SwiftUI

@Observable
@MainActor
final class CompassInlineQuizModel: Identifiable {
    let id = UUID()
    let topic: String
    let questionCount: Int
    let beforeScore: Double?

    enum Phase: Equatable { case generating, taking, completing, done, failed }
    var phase: Phase = .generating
    var quiz: Quiz?
    var reviewedQuiz: Quiz?     // completed quiz: correctAnswer/explanation populated
    var attemptId: String?
    var currentIndex = 0
    var answers: [Int: String] = [:]   // questionIndex → label ("A"/"B"/...)
    var checkScore: Double?
    var errorMessage: String?

    private let quizService = QuizService()

    init(topic: String, questionCount: Int, beforeScore: Double?) {
        self.topic = topic; self.questionCount = questionCount; self.beforeScore = beforeScore
    }

    var currentQuestion: QuizQuestion? {
        guard let quiz, currentIndex < quiz.questions.count else { return nil }
        return quiz.questions[currentIndex]
    }
    var totalQuestions: Int { quiz?.questions.count ?? questionCount }
    var isLastQuestion: Bool { currentIndex >= totalQuestions - 1 }

    func begin() async {
        phase = .generating
        do {
            let trigger = try await quizService.requestQuiz(topic: topic, questionCount: questionCount, assessmentType: "recall", source: "tutoring")
            var quizId = trigger.quizId
            var tries = 0
            while quizId == nil && tries < 30 {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let s = try await quizService.checkTriggerStatus(triggerId: trigger.triggerId)
                if s.status == "failed" { phase = .failed; errorMessage = "Couldn't build a check right now."; return }
                quizId = s.quizId; tries += 1
            }
            guard let qid = quizId else { phase = .failed; errorMessage = "The check took too long to build."; return }
            let q = try await quizService.fetchQuiz(id: qid)
            let attempt = try await quizService.startQuiz(id: qid)
            self.quiz = q; self.attemptId = attempt.id; self.currentIndex = 0; self.phase = .taking
        } catch {
            phase = .failed; errorMessage = "Couldn't start the check."
        }
    }

    func choose(_ label: String) async {
        guard phase == .taking, let quiz else { return }
        answers[currentIndex] = label
        _ = try? await quizService.submitAnswer(quizId: quiz.id, questionIndex: currentIndex, selectedAnswer: label, timeTaken: nil)
        if isLastQuestion { await complete() } else { currentIndex += 1 }
    }

    private func complete() async {
        guard let quiz else { return }
        phase = .completing
        do {
            let attempt = try await quizService.completeQuiz(id: quiz.id)
            checkScore = attempt.score?.percentage
            reviewedQuiz = try? await quizService.fetchQuiz(id: quiz.id)  // now has correctAnswer/explanation
            phase = .done
        } catch {
            phase = .failed; errorMessage = "Couldn't submit the check."
        }
    }
}
```
> Confirm `QuizTriggerResponse` field names (`triggerId`, `status`, `quizId`) against `ScaleUp/Models/Quiz.swift` (or wherever it's defined) and adjust if they differ.

- [ ] **Step 2: Build** to confirm it compiles (`xcodegen generate` + `xcodebuild build …`).
- [ ] **Step 3: Commit**
```bash
git add ScaleUp/Features/V2/Compass/CompassInlineQuizModel.swift ScaleUp.xcodeproj
git commit -m "feat(compass/ios): inline check-quiz lifecycle model"
```

---

### Task 8: `CompassInlineQuizCard` + wire into the chat

**Files:**
- Create: `ScaleUp/Features/V2/Compass/CompassInlineQuizCard.swift`
- Modify: `ScaleUp/Features/V2/Compass/CompassViewModel.swift` (`inlineQuiz` state + `startInlineCheck` + `finishInlineCheck`)
- Modify: `ScaleUp/Features/V2/Compass/V2CompassView.swift` (render the inline quiz card at the bottom of the chat)

- [ ] **Step 1: Add view-model state + methods** in `CompassViewModel.swift` (replace the Task 6 stub of `startInlineCheck`):
```swift
    var inlineQuiz: CompassInlineQuizModel?

    func startInlineCheck(topic: String, questionCount: Int, beforeScore: Double?) {
        let model = CompassInlineQuizModel(topic: topic, questionCount: questionCount, beforeScore: beforeScore)
        inlineQuiz = model
        Task {
            await model.begin()
            // when the learner finishes, post the result turn
            // (the view observes phase == .done and calls finishInlineCheck)
        }
    }

    func finishInlineCheck() async {
        guard let model = inlineQuiz, let attemptId = model.attemptId else { inlineQuiz = nil; return }
        let topic = model.topic, before = model.beforeScore
        inlineQuiz = nil
        do {
            let resp: V2APIResponse<CompassResponseEnvelope> = try await V2APIClient.shared.post(
                "/compass", body: CompassRequest(mode: "tutor_result", payload: CompassPayload(topic: topic, attemptId: attemptId, beforeScore: before))
            )
            let out = resp.data.output
            messages.append(.init(role: .compass, text: out.reply ?? "Nice work.",
                                  suggestedAction: out.suggestedAction, cards: out.cards ?? []))
        } catch {
            messages.append(.init(role: .compass, text: "You finished the check — your mastery will update shortly."))
        }
    }
```
> Add `attemptId` + `beforeScore` to `CompassPayload` (the request payload struct) if not present.

- [ ] **Step 2: Implement the card**
```swift
// ScaleUp/Features/V2/Compass/CompassInlineQuizCard.swift
import SwiftUI

struct CompassInlineQuizCard: View {
    @Bindable var model: CompassInlineQuizModel
    let onFinished: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch model.phase {
            case .generating:
                Label("Building your check…", systemImage: "sparkles").font(.subheadline).foregroundStyle(ColorTokens.gold)
                ProgressView().tint(ColorTokens.gold)
            case .taking:
                if let q = model.currentQuestion {
                    Text("Check · \(model.currentIndex + 1)/\(model.totalQuestions)").font(.caption.weight(.semibold)).foregroundStyle(ColorTokens.gold)
                    Text(q.questionText).font(.subheadline.weight(.semibold)).foregroundStyle(ColorTokens.textPrimary)
                    ForEach(q.options) { opt in
                        Button { Task { await model.choose(opt.label) } } label: {
                            HStack { Text("\(opt.label).").fontWeight(.bold); Text(opt.text); Spacer() }
                                .font(.subheadline).foregroundStyle(ColorTokens.textPrimary)
                                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                .background(ColorTokens.surface).clipShape(RoundedRectangle(cornerRadius: 8))
                                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(V2Theme.cardBorder, lineWidth: 1))
                        }.buttonStyle(.plain)
                    }
                }
            case .completing:
                Label("Scoring…", systemImage: "checkmark.circle").font(.subheadline).foregroundStyle(ColorTokens.gold)
                ProgressView().tint(ColorTokens.gold)
            case .done:
                // brief review of what they got right/wrong (correctAnswer now available)
                if let rq = model.reviewedQuiz {
                    Text("Check: \(Int((model.checkScore ?? 0).rounded()))%").font(.subheadline.weight(.bold)).foregroundStyle(ColorTokens.textPrimary)
                    ForEach(Array(rq.questions.enumerated()), id: \.offset) { idx, q in
                        let mine = model.answers[idx]
                        let correct = q.correctAnswer
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: mine == correct ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(mine == correct ? .green : .red).font(.caption)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(q.questionText).font(.caption).foregroundStyle(ColorTokens.textPrimary)
                                if mine != correct, let ex = q.explanation { Text(ex).font(.caption2).foregroundStyle(ColorTokens.textSecondary) }
                            }
                        }
                    }
                }
            case .failed:
                Text(model.errorMessage ?? "Couldn't run the check.").font(.subheadline).foregroundStyle(ColorTokens.textSecondary)
            }
        }
        .padding(12)
        .background(ColorTokens.gold.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(ColorTokens.gold.opacity(0.2), lineWidth: 1))
        .onChange(of: model.phase) { _, newPhase in
            if newPhase == .done || newPhase == .failed { onFinished() }
        }
    }
}
```

- [ ] **Step 3: Render it in `V2CompassView`** — at the bottom of the chat scroll (near the typing indicator), when `vm.inlineQuiz != nil`:
```swift
                if let quiz = vm.inlineQuiz {
                    CompassInlineQuizCard(model: quiz, onFinished: { Task { await vm.finishInlineCheck() } })
                        .padding(.horizontal)
                }
```
(`onFinished` fires once the check is `.done`/`.failed`; `finishInlineCheck` posts `tutor_result` and clears `inlineQuiz`, so the result message+card lands in the chat.)

- [ ] **Step 4: Build** (`xcodegen generate` + `xcodebuild build …`). Expected: BUILD SUCCEEDED.
- [ ] **Step 5: Commit**
```bash
git add ScaleUp/Features/V2/Compass/CompassInlineQuizCard.swift ScaleUp/Features/V2/Compass/CompassViewModel.swift ScaleUp/Features/V2/Compass/V2CompassView.swift ScaleUp.xcodeproj
git commit -m "feat(compass/ios): inline check-quiz card + chat wiring"
```

---

### Task 9: `tutoring_result` card (decode + view)

**Files:**
- Modify: `ScaleUp/Features/V2/Compass/CompassCard.swift` (payload + enum case + decode/encode)
- Modify: `ScaleUp/Features/V2/Compass/CompassCardViews.swift` (the view + dispatcher case)

- [ ] **Step 1: Add the payload + case** in `CompassCard.swift`:
```swift
// add to CompassCardPayload enum:
    case tutoringResult(CompassTutoringResultPayload)
// in init(from:): add to the switch
        case "tutoring_result":       payload = .tutoringResult(try c.decode(CompassTutoringResultPayload.self, forKey: .payload))
// in encode(to:): add
        case .tutoringResult(let p):  try c.encode(p, forKey: .payload)
// new struct (Codable, like the others):
struct CompassTutoringResultPayload: Codable {
    let topic: String
    let checkScore: Double?
    let beforeScore: Double?
    let afterScore: Double?
    let delta: Double?
}
```

- [ ] **Step 2: Add the view + dispatcher case** in `CompassCardViews.swift`:
```swift
// in CompassCardView's switch:
        case .tutoringResult(let p): CompassTutoringResultCard(payload: p)
// new view:
struct CompassTutoringResultCard: View {
    let payload: CompassTutoringResultPayload
    var body: some View {
        // reuse the gold CardShell used by the other cards
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "graduationcap.fill").font(.caption.weight(.semibold)).foregroundStyle(ColorTokens.gold)
                Text("Tutoring check · \(payload.topic.capitalized)").font(.caption.weight(.semibold)).foregroundStyle(ColorTokens.gold)
            }
            if let s = payload.checkScore { Text("You scored \(Int(s.rounded()))%").font(.title3.weight(.bold)).foregroundStyle(ColorTokens.textPrimary) }
            HStack(spacing: 6) {
                Text("\(payload.topic.capitalized) mastery:").font(.subheadline).foregroundStyle(ColorTokens.textSecondary)
                if let b = payload.beforeScore { Text("\(Int(b.rounded()))%").font(.subheadline).foregroundStyle(ColorTokens.textSecondary) }
                Image(systemName: "arrow.right").font(.caption2).foregroundStyle(ColorTokens.textSecondary)
                if let a = payload.afterScore { Text("\(Int(a.rounded()))%").font(.subheadline.weight(.bold)).foregroundStyle(ColorTokens.textPrimary) }
                if let d = payload.delta, d != 0 {
                    Text(d > 0 ? "↑\(Int(d.rounded()))" : "↓\(Int(abs(d).rounded()))")
                        .font(.caption.weight(.bold)).foregroundStyle(d > 0 ? .green : .red)
                }
            }
        }
        .padding(12)
        .background(ColorTokens.gold.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(ColorTokens.gold.opacity(0.2), lineWidth: 1))
    }
}
```

- [ ] **Step 3: Add a decode test** in `Tests/UnitTests/CompassCardDecodingTests.swift`:
```swift
    func testDecodesTutoringResultCard() throws {
        let json = """
        [{"type":"tutoring_result","payload":{"topic":"recursion","checkScore":75,"beforeScore":35,"afterScore":52,"delta":17}}]
        """.data(using: .utf8)!
        let cards = try JSONDecoder().decode([CompassCard].self, from: json)
        guard case let .tutoringResult(p) = cards[0].payload else { return XCTFail() }
        XCTAssertEqual(p.delta, 17)
        XCTAssertEqual(p.topic, "recursion")
    }
```

- [ ] **Step 4: Build + run the decode test** (`xcodegen generate`, then `xcodebuild test -scheme ScaleUp -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:ScaleUpTests/CompassCardDecodingTests -quiet`). Expected: PASS.
- [ ] **Step 5: Commit**
```bash
git add ScaleUp/Features/V2/Compass/CompassCard.swift ScaleUp/Features/V2/Compass/CompassCardViews.swift Tests/UnitTests/CompassCardDecodingTests.swift ScaleUp.xcodeproj
git commit -m "feat(compass/ios): tutoring_result card"
```

---

### Task 10: End-to-end build verification

- [ ] **Step 1:** `/opt/homebrew/bin/xcodegen generate`
- [ ] **Step 2:** `xcodebuild build -scheme ScaleUp -destination 'platform=iOS Simulator,name=iPhone 16' -configuration Debug -quiet` → BUILD SUCCEEDED.
- [ ] **Step 3: Manual verification** — open Compass, type "help me get better at \<a weak topic\>" → confirm the offer card → Start → explanation + topic card → "Ready for a quick check?" → inline questions → result card with the before→after delta + a "next topic" offer. Separately, ask "why am I stuck?" and confirm a proactive "Improve \<topic\>" card appears.
- [ ] **Step 4: Commit** (if xcodegen changed the project): `git add ScaleUp.xcodeproj && git commit -m "chore(compass/ios): regenerate project for tutoring loop"` (skip if nothing changed).

---

## Self-review — spec coverage

| Spec item | Task |
|---|---|
| `request_tutoring` intent | Task 1 |
| Proactive-offer hook | Task 2 |
| `tutor_topic` (misconception-grounded explanation + check offer) | Task 3 |
| `tutor_result` (mastery delta + chain) | Task 4 |
| `tutoring_result` card + modes in OpenAPI | Task 5 |
| Offer / check-CTA cards (iOS) | Task 6 |
| Inline check lifecycle (reuses quiz pipeline) | Task 7 |
| Inline quiz card + chat wiring + end-of-check review | Task 8 |
| `tutoring_result` card (iOS) | Task 9 |
| Build/integration | Task 10 |

**Non-goals honored:** no new mastery-write path (the check drives the existing `start→answer→complete→scoreQuiz→quizAnalyzer→updateMastery` pipeline); no plan/objective mutation; MCQ checks (`assessmentType:'recall'`); one topic per loop (chain via `tutor_result`'s next-topic offer); end-of-check review (not live per-question, per the approved decision). **Gotchas covered:** async quiz gen → poll (Task 7); async mastery + lazy readiness → `tutor_result` re-reads `getTopicDetail` (Task 4); `questionCount: 4` passed explicitly (Task 7).

**Placeholder scan:** none — every code step has full code; the iOS "mirror this call site" notes point at exact existing patterns (`callConversation` post, `suggestedActionCard`, `QuizSessionViewModel`), not unfinished work. **Type consistency:** `start_tutoring`/`start_check_quiz`/`tutoring_result` + the `{topic, checkScore, beforeScore, afterScore, delta}` payload are identical across backend (Tasks 3–5) and iOS (Tasks 6, 9).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-04-compass-tutoring-loop.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
