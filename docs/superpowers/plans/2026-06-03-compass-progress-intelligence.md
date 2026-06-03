# Compass Progress Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Compass answer grounded questions about a learner's whole journey ("why am I stuck at 70%", "what are my weakest topics", "how did I do on my latest interview / the PM quiz") using a real-time progress snapshot + read-only retrieval tools, and render rich answer cards.

**Architecture:** A new `compassProgressService` composes existing analytics/readiness/mastery services into (a) a compact always-on snapshot injected into Compass's prompt and (b) read-only retrieval functions. A new `compassTools` exposes those functions as Anthropic tool-use tools (server-scoped to the caller). The `compassOrchestrator` gains a tool-use loop (mirroring the proven `compassCoder.turn()` pattern) on the `conversation`/`coach` modes, fixes its stale readiness/mastery context, and projects invoked-tool outputs into typed `cards` on the response. iOS decodes and renders those cards. The resume-builder stub is removed.

**Tech Stack:** Node.js / Express / Mongoose / Redis / Anthropic SDK (Claude Sonnet 4) on the backend; `node:test` + `node:assert/strict` for tests (run a single file with `node --test --test-force-exit <path>`, full suite with `npm test`). SwiftUI on iOS.

**Spec:** `docs/superpowers/specs/2026-06-03-compass-progress-intelligence-design.md`

---

## Shared type contract (used across all tasks — keep names identical)

These are the exact shapes every task produces/consumes. Do not rename fields between tasks.

```js
// ProgressSnapshot — getSnapshot(userId)
{
  readiness: { value: Number, target: Number, source: String, trend: String|null,
               draggers: [{ name: String, score: Number }] } | null,
  mastery: {
    strong: [{ topic: String, score: Number, trend: String }],   // up to 3
    weak:   [{ topic: String, score: Number, trend: String }],   // up to 5
  },
  pulse: {
    quizzes:      { count: Number, avgPercent: Number|null },
    interviews:   { count: Number, avgScore: Number|null, weakestDimension: String|null },
    coding:       { gradedCount: Number, avgScore: Number|null,
                    axes: { prompting:Number, verification:Number, decomposition:Number, refactoring:Number }|null },
    competitions: { count: Number, bestScore: Number|null, streak: Number },
    content:      { completedCount: Number, minutesSpent: Number },
    notes:        { count: Number },
  },
  signals: {
    dueForReviewCount: Number,
    dueConcepts: [String],                                   // up to 5
    misconceptions: [{ tag: String, explanation: String }], // up to 3
    plan: { week: Number, totalWeeks: Number, tasksDone: Number, tasksTotal: Number } | null,
    streak: Number,
  },
}

// ReadinessExplanation — explainReadiness(userId)
{ value: Number, target: Number, source: String, distanceToTarget: Number,
  contributors: [{ name: String, score: Number, weight: Number|null, assessed: Boolean }],
  topDraggers:  [{ name: String, score: Number, weight: Number|null }],
  note: String }

// ActivityResult — getLatestResult(userId,type) / findActivity(userId,type,query)
{ activityType: String,            // 'quiz'|'interview'|'coding'|'competition'|'content'
  title: String, date: String|null,
  overallScore: Number|null, scoreLabel: String,
  dimensions: [{ name: String, score: Number, feedback: String|null }],   // [] if none
  highlights: { strengths: [String], improvements: [String] } }

// TopicDetail — getTopicDetail(userId,topic)
{ topic: String, score: Number|null, level: String|null, trend: String|null,
  history: [{ score: Number, date: String }],
  relatedActivities: [{ type: String, title: String, score: Number|null, date: String|null }],
  misconceptions: [{ tag: String, explanation: String }],
  dueConcepts: [String] }

// WeakTopic — listWeakTopics(userId,limit)
{ topic: String, score: Number, trend: String, assessedBy: [String] }

// ActivityListItem — listRecentActivity(userId,limit,type?)
{ type: String, title: String, score: Number|null, date: String|null }

// Card (attached to POST /compass response under data.cards)
{ type: String, payload: Object }
//   readiness_explanation -> ReadinessExplanation
//   activity_result       -> ActivityResult
//   topic_detail          -> TopicDetail
//   weak_topics           -> { topics: WeakTopic[] }
//   recent_activity       -> { items: ActivityListItem[] }
```

**Tool → service fn → card type map (single source of truth):**

| tool name | service fn | card type |
|---|---|---|
| `explain_readiness` | `explainReadiness` | `readiness_explanation` |
| `get_latest_result` | `getLatestResult` | `activity_result` |
| `find_activity` | `findActivity` | `activity_result` |
| `get_topic_detail` | `getTopicDetail` | `topic_detail` |
| `list_weak_topics` | `listWeakTopics` | `weak_topics` (`{topics}`) |
| `list_recent_activity` | `listRecentActivity` | `recent_activity` (`{items}`) |

---

## Phase 1 — Backend progress service

### Task 1: `compassProgressService.getSnapshot` + snapshot rendering

**Files:**
- Create: `src/services/v2/compassProgressService.js`
- Create: `src/test/v2/compassProgress.snapshot.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassProgress.snapshot.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SVC = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
function stub(p, exports) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports }; }
function load() { delete require.cache[SVC]; return require(SVC); }

// Resolve the dependency paths the service requires, so we can stub them.
const READINESS = path.resolve(__dirname, '../../services/readiness/readinessService.js');
const USERCTX  = path.resolve(__dirname, '../../services/userContextService.js');
const KP       = path.resolve(__dirname, '../../models/KnowledgeProfile.js');
const PLAN     = path.resolve(__dirname, '../../models/Plan.js');
const QA       = path.resolve(__dirname, '../../models/QuizAttempt.js');
const IS       = path.resolve(__dirname, '../../models/InterviewSession.js');
const CP       = path.resolve(__dirname, '../../models/ContentProgress.js');
const COMPPROF = path.resolve(__dirname, '../../models/CompetitionProfile.js');

function stubAll() {
  stub(READINESS, { getServedReadiness: async () => ({ value: 70, target: 80, source: 'knowledge', trend: 'stable', breakdown: null, draggers: [{ name: 'recursion', score: 40 }] }) });
  stub(USERCTX, { getUserContext: async () => ({ misconceptions: [{ tag: 'off_by_one', explanation: 'boundary error' }], dueForReview: [{ concept: 'closures' }], recentTopicsTouched: ['arrays'], recentAITutor: { topicsCovered: [], openQuestions: [] } }) });
  stub(KP, { findOne: () => ({ lean: async () => ({ topicMastery: [
    { topic: 'arrays', score: 82, trend: 'improving', quizzesTaken: 3 },
    { topic: 'recursion', score: 40, trend: 'declining', quizzesTaken: 2 },
  ] }) }) });
  stub(PLAN, { findOne: () => ({ lean: async () => ({ currentWeek: 2, totalWeeks: 6, tasks: [] }) }) });
  stub(QA, { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ score: { percentage: 80 } }, { score: { percentage: 60 } }] }) }) }) });
  stub(IS, { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
  stub(CP, { countDocuments: async () => 4, find: () => ({ lean: async () => [{ totalTimeSpent: 600 }] }) });
  stub(COMPPROF, { findOne: () => ({ lean: async () => ({ currentChallengeStreak: 3, totalChallengesCompleted: 5 }) }) });
}

test('getSnapshot: composes readiness, mastery, pulse and signals', async () => {
  stubAll();
  const svc = load();
  const snap = await svc.getSnapshot('u1');
  assert.equal(snap.readiness.value, 70);
  assert.equal(snap.readiness.target, 80);
  assert.equal(snap.mastery.strong[0].topic, 'arrays');
  assert.equal(snap.mastery.weak[0].topic, 'recursion');
  assert.equal(snap.pulse.quizzes.count, 2);
  assert.equal(snap.pulse.quizzes.avgPercent, 70);
  assert.equal(snap.signals.plan.week, 2);
});

test('getSnapshot: never throws when a source fails — omits that slice', async () => {
  stubAll();
  stub(READINESS, { getServedReadiness: async () => { throw new Error('boom'); } });
  const svc = load();
  const snap = await svc.getSnapshot('u1');
  assert.equal(snap.readiness, null);          // failed slice degrades to null
  assert.ok(snap.mastery);                      // other slices still present
});

test('renderSnapshot: produces non-empty prompt text from a snapshot', async () => {
  stubAll();
  const svc = load();
  const snap = await svc.getSnapshot('u1');
  const text = svc.renderSnapshot(snap);
  assert.match(text, /readiness/i);
  assert.match(text, /recursion/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassProgress.snapshot.test.js`
Expected: FAIL — `Cannot find module '.../compassProgressService.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/services/v2/compassProgressService.js
'use strict';

/**
 * Compass Progress Intelligence — the omniscient, real-time progress layer.
 *
 * Composes existing services (readiness, mastery, activity analytics) into:
 *   - getSnapshot(userId): a compact always-on digest injected into Compass's prompt
 *   - retrieval functions (explainReadiness, getLatestResult, findActivity,
 *     getTopicDetail, listWeakTopics, listRecentActivity) backing the read-only tools
 *
 * READ-ONLY. Nothing here mutates user state. Every slice is best-effort:
 * a failing source omits its slice rather than failing the whole snapshot.
 */

const readinessService = require('../readiness/readinessService');
const userContextService = require('../userContextService');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const Plan = require('../../models/Plan');
const QuizAttempt = require('../../models/QuizAttempt');
const InterviewSession = require('../../models/InterviewSession');
const ContentProgress = require('../../models/ContentProgress');
const CompetitionProfile = require('../../models/CompetitionProfile');

const SNAPSHOT_TTL_MS = 90 * 1000;
const _cache = new Map(); // userId -> { at, snap }

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { console.warn('[compassProgress]', e.message); return fallback; }
}

function avg(nums) {
  const xs = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  if (!xs.length) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

async function getSnapshot(userId) {
  if (!userId) return null;
  const cached = _cache.get(String(userId));
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.snap;

  const [readiness, mastery, pulse, signals] = await Promise.all([
    safe(() => buildReadinessSlice(userId), null),
    safe(() => buildMasterySlice(userId), { strong: [], weak: [] }),
    safe(() => buildPulseSlice(userId), emptyPulse()),
    safe(() => buildSignalsSlice(userId), emptySignals()),
  ]);

  const snap = { readiness, mastery, pulse, signals };
  _cache.set(String(userId), { at: Date.now(), snap });
  return snap;
}

function invalidate(userId) { _cache.delete(String(userId)); }

async function buildReadinessSlice(userId) {
  const r = await readinessService.getServedReadiness(userId);
  if (!r) return null;
  return {
    value: r.value, target: r.target, source: r.source, trend: r.trend || null,
    draggers: (r.draggers || []).slice(0, 3),
  };
}

async function buildMasterySlice(userId) {
  const kp = await KnowledgeProfile.findOne({ userId }).lean();
  const tm = (kp?.topicMastery || []).filter((t) => typeof t.score === 'number');
  const sorted = [...tm].sort((a, b) => b.score - a.score);
  const strong = sorted.filter((t) => t.score >= 75).slice(0, 3)
    .map((t) => ({ topic: t.topic, score: t.score, trend: t.trend || 'stable' }));
  const weak = sorted.filter((t) => t.score < 60 && (t.quizzesTaken || 0) >= 1).reverse().slice(0, 5)
    .map((t) => ({ topic: t.topic, score: t.score, trend: t.trend || 'stable' }));
  return { strong, weak };
}

function emptyPulse() {
  return {
    quizzes: { count: 0, avgPercent: null },
    interviews: { count: 0, avgScore: null, weakestDimension: null },
    coding: { gradedCount: 0, avgScore: null, axes: null },
    competitions: { count: 0, bestScore: null, streak: 0 },
    content: { completedCount: 0, minutesSpent: 0 },
    notes: { count: 0 },
  };
}

async function buildPulseSlice(userId) {
  const p = emptyPulse();
  const [quizzes, interviews, comp, contentCount, contentDocs] = await Promise.all([
    safe(() => QuizAttempt.find({ userId, status: 'completed' }).sort({ completedAt: -1 }).limit(20).lean(), []),
    safe(() => InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] } }).sort({ completedAt: -1 }).limit(20).lean(), []),
    safe(() => CompetitionProfile.findOne({ userId }).lean(), null),
    safe(() => ContentProgress.countDocuments({ userId, isCompleted: true }), 0),
    safe(() => ContentProgress.find({ userId, isCompleted: true }).lean(), []),
  ]);
  p.quizzes = { count: quizzes.length, avgPercent: avg(quizzes.map((q) => q.score?.percentage)) };
  const dims = ['communication', 'content', 'structure', 'confidence'];
  const dimAvgs = dims.map((d) => ({ d, v: avg(interviews.map((i) => i.evaluation?.[d]?.score)) })).filter((x) => x.v != null);
  dimAvgs.sort((a, b) => a.v - b.v);
  p.interviews = { count: interviews.length, avgScore: avg(interviews.map((i) => i.evaluation?.overallScore)), weakestDimension: dimAvgs[0]?.d || null };
  p.competitions = { count: comp?.totalChallengesCompleted || 0, bestScore: null, streak: comp?.currentChallengeStreak || 0 };
  p.content = { completedCount: contentCount, minutesSpent: Math.round(contentDocs.reduce((a, c) => a + (c.totalTimeSpent || 0), 0) / 60) };
  // coding + notes are filled by their dedicated sources in Task 3/late; default 0 here.
  return p;
}

function emptySignals() {
  return { dueForReviewCount: 0, dueConcepts: [], misconceptions: [], plan: null, streak: 0 };
}

async function buildSignalsSlice(userId) {
  const [deep, plan, comp] = await Promise.all([
    safe(() => userContextService.getUserContext(userId), null),
    safe(() => Plan.findOne({ userId, status: { $in: ['active', 'ready'] } }).lean(), null),
    safe(() => CompetitionProfile.findOne({ userId }).lean(), null),
  ]);
  const due = (deep?.dueForReview || []).map((d) => d.concept).filter(Boolean);
  return {
    dueForReviewCount: due.length,
    dueConcepts: due.slice(0, 5),
    misconceptions: (deep?.misconceptions || []).slice(0, 3).map((m) => ({ tag: m.tag, explanation: m.explanation })),
    plan: plan ? {
      week: plan.currentWeek, totalWeeks: plan.totalWeeks,
      tasksDone: (plan.tasks || []).filter((t) => t.weekNumber === plan.currentWeek && t.completedAt).length,
      tasksTotal: (plan.tasks || []).filter((t) => t.weekNumber === plan.currentWeek).length,
    } : null,
    streak: comp?.currentChallengeStreak || 0,
  };
}

function renderSnapshot(snap) {
  if (!snap) return '';
  const L = [];
  if (snap.readiness) {
    const d = (snap.readiness.draggers || []).map((x) => `${x.name} (${x.score}%)`).join(', ');
    L.push(`Readiness: ${snap.readiness.value}% (target ${snap.readiness.target}%, trend ${snap.readiness.trend || 'n/a'}).${d ? ` Dragging it down: ${d}.` : ''}`);
  }
  if (snap.mastery?.strong?.length) L.push(`Strong: ${snap.mastery.strong.map((t) => `${t.topic} ${t.score}%`).join(', ')}.`);
  if (snap.mastery?.weak?.length) L.push(`Weak: ${snap.mastery.weak.map((t) => `${t.topic} ${t.score}%`).join(', ')}.`);
  const p = snap.pulse;
  if (p) {
    L.push(`Activity: quizzes ${p.quizzes.count} (avg ${p.quizzes.avgPercent ?? '—'}%), interviews ${p.interviews.count} (avg ${p.interviews.avgScore ?? '—'}, weakest ${p.interviews.weakestDimension || '—'}), coding ${p.coding.gradedCount} graded, competitions ${p.competitions.count} (streak ${p.competitions.streak}), content ${p.content.completedCount} done, notes ${p.notes.count}.`);
  }
  const s = snap.signals;
  if (s) {
    if (s.dueForReviewCount) L.push(`Due for review: ${s.dueConcepts.join(', ')}.`);
    if (s.misconceptions?.length) L.push(`Recurring misconceptions: ${s.misconceptions.map((m) => m.tag).join(', ')}.`);
    if (s.plan) L.push(`Plan: week ${s.plan.week}/${s.plan.totalWeeks}, ${s.plan.tasksDone}/${s.plan.tasksTotal} tasks this week.`);
  }
  return L.join('\n');
}

module.exports = { getSnapshot, renderSnapshot, invalidate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassProgress.snapshot.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/v2/compassProgressService.js src/test/v2/compassProgress.snapshot.test.js
git commit -m "feat(compass): progress snapshot service (getSnapshot + renderSnapshot)"
```

---

### Task 2: `readinessService.getServedReadiness` (shared helper) + `explainReadiness`

**Why:** "Why am I at 70?" must use the *served* number. The `/you/overview` route (`src/routes/v2/you.js:62-140`) already composes `assembleLegacy` → `computeComposite` (shadow) → `chooseServed` → `getEffectiveTarget` → breakdown. Extract that exact composition into `readinessService.getServedReadiness(userId)` so Compass and the You tab can never disagree, then build `explainReadiness` on top.

**Files:**
- Modify: `src/services/readiness/readinessService.js` (add `getServedReadiness`)
- Modify: `src/services/v2/compassProgressService.js` (add `explainReadiness`, and make `buildReadinessSlice` reuse it)
- Create: `src/test/v2/compassProgress.readiness.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassProgress.readiness.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SVC = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const READINESS = path.resolve(__dirname, '../../services/readiness/readinessService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[SVC]; return require(SVC); }

test('explainReadiness: surfaces contributors + top draggers + distance to target', async () => {
  stub(READINESS, {
    getServedReadiness: async () => ({
      value: 70, target: 80, source: 'composite', trend: 'improving',
      breakdown: [
        { name: 'Data Structures', score: 55, weight: 8, assessed: true },
        { name: 'System Design', score: 40, weight: 6, assessed: true },
        { name: 'Communication', score: 90, weight: 3, assessed: true },
      ],
      draggers: [{ name: 'System Design', score: 40 }, { name: 'Data Structures', score: 55 }],
    }),
  });
  const svc = load();
  const out = await svc.explainReadiness('u1');
  assert.equal(out.value, 70);
  assert.equal(out.distanceToTarget, 10);
  assert.equal(out.contributors.length, 3);
  assert.equal(out.topDraggers[0].name, 'System Design');
  assert.match(out.note, /70/);
});

test('explainReadiness: degrades to topic-average note when no breakdown (legacy source)', async () => {
  stub(READINESS, {
    getServedReadiness: async () => ({ value: 62, target: 80, source: 'knowledge', trend: 'stable', breakdown: null, draggers: [{ name: 'recursion', score: 35 }] }),
  });
  const svc = load();
  const out = await svc.explainReadiness('u1');
  assert.equal(out.value, 62);
  assert.equal(out.contributors.length, 0);          // no competency breakdown available
  assert.equal(out.topDraggers[0].name, 'recursion'); // falls back to draggers
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassProgress.readiness.test.js`
Expected: FAIL — `svc.explainReadiness is not a function`.

- [ ] **Step 3a: Extract `getServedReadiness` into `readinessService.js`**

Read `src/routes/v2/you.js:42-140` and move the readiness-assembly block (the `legacy`/`shadow`/`served`/`effectiveTarget`/`readinessBreakdown` computation, lines 62-140) into a new exported function. Add to `src/services/readiness/readinessService.js`:

```js
// src/services/readiness/readinessService.js — append to module
const mongoose = require('mongoose');

/**
 * The single served-readiness composition used by BOTH /you/overview and Compass.
 * Mirrors the inline logic previously in routes/v2/you.js so the number never drifts.
 * Returns { value, source, target, targetBands, breakdown|null, coverage|null,
 *           coding|null, draggers[] }. draggers = lowest contributors (composite
 *           breakdown when available, else lowest topicMastery entries).
 */
async function getServedReadiness(userId) {
  const UserObjective = mongoose.model('UserObjective');
  const Plan = mongoose.model('Plan');
  const Journey = mongoose.model('Journey');
  const KnowledgeProfile = mongoose.model('KnowledgeProfile');
  const CompetitionProfile = mongoose.model('CompetitionProfile');
  const InterviewSession = mongoose.model('InterviewSession');
  const DiagnosticAttempt = mongoose.model('DiagnosticAttempt');
  const targetService = require('./targetService');
  const featureFlags = require('../../config/featureFlags');
  const { evaluateCodingEligibility } = require('../../coding/services/codingEligibility');
  const readinessUpdater = require('../../coding/services/readinessUpdater');
  const { diagnosticBaselineReadiness } = require('./readinessBaseline'); // existing helper used by you.js

  const [objective, plan, journey, knowledge, competition, latestAttempt] = await Promise.all([
    UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
    Plan.findOne({ userId, status: { $in: ['active', 'ready'] } }).lean(),
    Journey.findOne({ userId, status: 'active' }).lean(),
    KnowledgeProfile.findOne({ userId }).lean(),
    CompetitionProfile.findOne({ userId }).lean(),
    DiagnosticAttempt.findOne({ userId, status: 'completed' }).sort({ completedAt: -1 }).lean(),
  ]);

  let codingComponent = null;
  try {
    const elig = evaluateCodingEligibility(objective);
    if (elig.eligible) codingComponent = await readinessUpdater.getMetaSkillComponent({ user_id: userId, role_track: elig.role_track });
  } catch (_) {}

  const diagnosticBaseline = diagnosticBaselineReadiness(latestAttempt);
  const legacy = assembleLegacy({ plan, journey, knowledge, diagnosticBaseline, codingComponent });
  const legacyValue = legacy.value;

  let shadow = null;
  try {
    if (objective?.analysis?.competencies?.length) {
      const cms = require('./competencyMasteryService');
      const elig = evaluateCodingEligibility(objective);
      const now = new Date();
      const CapstoneSession = mongoose.model('CapstoneSession');
      const DrillAttempt = mongoose.model('DrillAttempt');
      const MetaSkillMastery = mongoose.model('MetaSkillMastery');
      const [capstones, drills, mastery, interviews] = await Promise.all([
        elig.eligible ? CapstoneSession.find({ user_id: userId, status: 'graded' }).select('result.overall_score graded_at').sort({ graded_at: -1 }).limit(10).lean() : [],
        elig.eligible ? DrillAttempt.find({ user_id: userId, status: 'graded' }).select('grade.overall_score submitted_at').sort({ submitted_at: -1 }).limit(20).lean() : [],
        elig.eligible ? MetaSkillMastery.findOne({ user_id: userId, role_track: elig.role_track }).lean() : null,
        InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] } }).select('evaluation.overallScore completedAt').sort({ completedAt: -1 }).limit(10).lean(),
      ]);
      const codingSignal = elig.eligible ? cms.buildCodingSignal({ capstones, drills, mastery, now }) : null;
      const interviewSignal = cms.buildInterviewSignal({ interviews, now });
      const behavioral = cms.buildBehavioralSignal({ streak: competition?.currentStreak || 0, contentCompleted: 0, activeDays7: 0 });
      const composite = computeComposite({ objective, ctx: { coding: !!elig.eligible }, knowledge, codingSignal, interviewSignal, behavioral, now });
      if (composite) shadow = { value: composite.value, confidence: composite.confidence, coverage: composite.coverage, breakdown: composite.breakdown, delta: composite.value - legacyValue };
    }
  } catch (_) {}

  const served = chooseServed({ legacyValue, shadow, flagOn: featureFlags.compositeReadiness });
  const effectiveTarget = targetService.getEffectiveTarget(objective);
  const targetBands = targetService.targetBands(effectiveTarget);

  const breakdown = Array.isArray(shadow?.breakdown)
    ? shadow.breakdown.map((b) => ({ name: b.competency, weight: b.weight, score: b.score, assessed: !!b.assessed, primitive: b.primitive })).sort((a, b) => b.weight - a.weight)
    : null;

  // draggers: from breakdown when served is composite/blend, else lowest topicMastery
  let draggers;
  if (breakdown && (served.source === 'composite' || served.source === 'blend')) {
    draggers = breakdown.filter((b) => b.assessed).sort((a, b) => a.score - b.score).slice(0, 3).map((b) => ({ name: b.name, score: b.score }));
  } else {
    draggers = (knowledge?.topicMastery || []).filter((t) => typeof t.score === 'number').sort((a, b) => a.score - b.score).slice(0, 3).map((t) => ({ name: t.topic, score: t.score }));
  }

  return { value: served.value, source: served.source, target: effectiveTarget, targetBands, breakdown, coverage: shadow?.coverage ?? null, coding: legacy.coding || null, draggers };
}

module.exports.getServedReadiness = getServedReadiness;
```

> NOTE for the implementer: confirm the exact require paths for `codingEligibility`, `readinessUpdater`, and the diagnostic-baseline helper by matching the `require(...)`/imports at the top of `src/routes/v2/you.js`. They already exist and are used there; reuse the same modules. As a follow-up cleanup, refactor `you.js` `/overview` to call `getServedReadiness` instead of its inline block (out of scope for green tests here; safe to do in the same commit if time permits).

- [ ] **Step 3b: Add `explainReadiness` to `compassProgressService.js`**

```js
// src/services/v2/compassProgressService.js — add and export
async function explainReadiness(userId) {
  const r = await readinessService.getServedReadiness(userId);
  if (!r) return { value: null, target: null, source: null, distanceToTarget: null, contributors: [], topDraggers: [], note: 'No readiness data yet — complete a quiz or assessment to start measuring.' };
  const contributors = Array.isArray(r.breakdown)
    ? r.breakdown.map((b) => ({ name: b.name, score: b.score, weight: b.weight ?? null, assessed: !!b.assessed }))
    : [];
  const topDraggers = (r.draggers || []).map((d) => ({ name: d.name, score: d.score, weight: d.weight ?? null }));
  const distanceToTarget = (typeof r.value === 'number' && typeof r.target === 'number') ? Math.max(0, r.target - r.value) : null;
  const note = contributors.length
    ? `Your readiness is ${r.value}% against a ${r.target}% target. It's a weighted blend of your competencies; the lowest-scoring assessed ones pull it down most.`
    : `Your readiness is ${r.value}% against a ${r.target}% target — currently the average of your assessed topic scores. The lowest are dragging it down.`;
  return { value: r.value, target: r.target, source: r.source, distanceToTarget, contributors, topDraggers, note };
}
module.exports.explainReadiness = explainReadiness;
```

Also update `buildReadinessSlice` (Task 1) to reuse the same `getServedReadiness` call (it already does) — no change needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassProgress.readiness.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/readiness/readinessService.js src/services/v2/compassProgressService.js src/test/v2/compassProgress.readiness.test.js
git commit -m "feat(compass): shared getServedReadiness + explainReadiness"
```

---

### Task 3: `getLatestResult(userId, type)` — per-activity result detail

**Files:**
- Modify: `src/services/v2/compassProgressService.js`
- Create: `src/test/v2/compassProgress.latest.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassProgress.latest.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SVC = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const IS = path.resolve(__dirname, '../../models/InterviewSession.js');
const CAP = path.resolve(__dirname, '../../coding/models/capstoneSession.model.js');
const BUNDLE = path.resolve(__dirname, '../../coding/models/artifactBundle.model.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[SVC]; return require(SVC); }

test('getLatestResult(interview): maps evaluation to dimensions + highlights', async () => {
  stub(IS, { findOne: () => ({ sort: () => ({ lean: async () => ({
    interviewType: 'placement_technical', completedAt: new Date('2026-05-01'),
    evaluation: { overallScore: 72, communication: { score: 7, feedback: 'clear' }, content: { score: 6, feedback: 'ok' },
      structure: { score: 8, feedback: 'good' }, confidence: { score: 5, feedback: 'nervous' },
      overallStrengths: ['structure'], overallImprovements: ['depth'] },
  }) }) }) });
  const svc = load();
  const out = await svc.getLatestResult('u1', 'interview');
  assert.equal(out.activityType, 'interview');
  assert.equal(out.overallScore, 72);
  assert.equal(out.dimensions.length, 4);
  assert.equal(out.highlights.improvements[0], 'depth');
});

test('getLatestResult(coding): maps capstone 6 dimensions', async () => {
  stub(CAP, { findOne: () => ({ sort: () => ({ lean: async () => ({
    bundle_id: 'b1', graded_at: new Date('2026-05-02'),
    result: { overall_score: 68, dimension_scores: { correctness: 70, code_quality: 65, ai_pair_effectiveness: 80, verification_discipline: 60, decomposition: 66, reflection_quality: 64 },
      dimension_feedback: { correctness: { why: 'mostly', to_improve: 'edge cases' } }, strengths: ['tests'], gaps: ['edge cases'] },
  }) }) }) });
  stub(BUNDLE, { findById: () => ({ lean: async () => ({ brief: 'Build a rate limiter\nmore' }) }) });
  const svc = load();
  const out = await svc.getLatestResult('u1', 'coding');
  assert.equal(out.activityType, 'coding');
  assert.equal(out.overallScore, 68);
  assert.equal(out.dimensions.length, 6);
  assert.equal(out.title, 'Build a rate limiter');
});

test('getLatestResult: returns null when nothing found', async () => {
  stub(IS, { findOne: () => ({ sort: () => ({ lean: async () => null }) }) });
  const svc = load();
  assert.equal(await svc.getLatestResult('u1', 'interview'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassProgress.latest.test.js`
Expected: FAIL — `svc.getLatestResult is not a function`.

- [ ] **Step 3: Implement**

```js
// src/services/v2/compassProgressService.js — add requires at top
const mongoose = require('mongoose');
const Quiz = require('../../models/Quiz');
// (QuizAttempt, InterviewSession, ContentProgress already required in Task 1)

function fmtDate(d) { return d ? new Date(d).toISOString().slice(0, 10) : null; }

async function getLatestResult(userId, type) {
  switch (type) {
    case 'quiz':       return quizResult(await QuizAttempt.findOne({ userId, status: 'completed' }).sort({ completedAt: -1 }).lean());
    case 'interview':  return interviewResult(await InterviewSession.findOne({ userId, status: { $in: ['completed', 'evaluated'] } }).sort({ completedAt: -1 }).lean());
    case 'coding':     return await codingResult(await mongoose.model('CapstoneSession').findOne({ user_id: userId, status: 'graded' }).sort({ graded_at: -1 }).lean());
    case 'competition':return await competitionResult(userId);
    case 'content':    return contentResult(await ContentProgress.findOne({ userId, isCompleted: true }).sort({ completedAt: -1 }).lean());
    default:           return null;
  }
}

function quizResult(a) {
  if (!a) return null;
  const pct = a.score?.percentage ?? null;
  return {
    activityType: 'quiz', title: 'Quiz', date: fmtDate(a.completedAt),
    overallScore: pct, scoreLabel: pct != null ? `${pct}%` : '—',
    dimensions: (a.topicBreakdown || []).slice(0, 6).map((t) => ({ name: t.topic, score: t.percentage, feedback: null })),
    highlights: { strengths: (a.analysis?.strengths || []).slice(0, 3), improvements: (a.analysis?.weaknesses || []).slice(0, 3) },
  };
}

function interviewResult(s) {
  if (!s) return null;
  const e = s.evaluation || {};
  const dims = ['communication', 'content', 'structure', 'confidence']
    .filter((d) => e[d]).map((d) => ({ name: d, score: e[d].score, feedback: e[d].feedback || null }));
  return {
    activityType: 'interview', title: (s.interviewType || 'interview').replace(/_/g, ' '), date: fmtDate(s.completedAt),
    overallScore: e.overallScore ?? null, scoreLabel: e.overallScore != null ? `${e.overallScore}/100` : '—',
    dimensions: dims,
    highlights: { strengths: (e.overallStrengths || []).slice(0, 3), improvements: (e.overallImprovements || []).slice(0, 3) },
  };
}

async function codingResult(c) {
  if (!c) return null;
  const r = c.result || {};
  const ds = r.dimension_scores || {};
  const dims = Object.keys(ds).map((k) => ({ name: k.replace(/_/g, ' '), score: ds[k], feedback: r.dimension_feedback?.[k]?.to_improve || null }));
  let title = 'Capstone';
  try { const b = await mongoose.model('ArtifactBundle').findById(c.bundle_id).lean(); if (b?.brief) title = String(b.brief).split('\n')[0].trim(); } catch (_) {}
  return {
    activityType: 'coding', title, date: fmtDate(c.graded_at),
    overallScore: r.overall_score ?? null, scoreLabel: r.overall_score != null ? `${r.overall_score}/100` : '—',
    dimensions: dims,
    highlights: { strengths: (r.strengths || []).slice(0, 3), improvements: (r.gaps || []).slice(0, 3) },
  };
}

async function competitionResult(userId) {
  try {
    const competitionService = require('../competitionService');
    const history = await competitionService.getCompetitionHistory(userId, 1);
    const h = Array.isArray(history) ? history[0] : (history?.items || history?.history || [])[0];
    if (!h) return null;
    return {
      activityType: 'competition', title: h.topic ? `Challenge: ${h.topic}` : 'Daily challenge', date: fmtDate(h.completedAt),
      overallScore: h.handicappedScore ?? h.rawScore ?? null, scoreLabel: h.rawScore != null ? `${h.rawScore}% (raw)` : '—',
      dimensions: [], highlights: { strengths: h.isPersonalBest ? ['personal best'] : [], improvements: [] },
    };
  } catch (_) { return null; }
}

function contentResult(c) {
  if (!c) return null;
  return {
    activityType: 'content', title: 'Recently completed content', date: fmtDate(c.completedAt),
    overallScore: c.percentageCompleted ?? null, scoreLabel: c.percentageCompleted != null ? `${c.percentageCompleted}% watched` : '—',
    dimensions: [], highlights: { strengths: [], improvements: [] },
  };
}

module.exports.getLatestResult = getLatestResult;
// export the formatters too (reused by findActivity in Task 4)
module.exports._fmt = { quizResult, interviewResult, codingResult, contentResult, fmtDate };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassProgress.latest.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/v2/compassProgressService.js src/test/v2/compassProgress.latest.test.js
git commit -m "feat(compass): getLatestResult across quiz/interview/coding/competition/content"
```

---

### Task 4: `findActivity(userId, type, query)`

**Files:**
- Modify: `src/services/v2/compassProgressService.js`
- Create: `src/test/v2/compassProgress.find.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassProgress.find.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SVC = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const QUIZ = path.resolve(__dirname, '../../models/Quiz.js');
const QA = path.resolve(__dirname, '../../models/QuizAttempt.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[SVC]; return require(SVC); }

test('findActivity(quiz, "product management"): finds the matching quiz attempt', async () => {
  stub(QUIZ, { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ _id: 'q1', topic: 'product management' }] }) }) }) });
  stub(QA, { findOne: () => ({ sort: () => ({ lean: async () => ({ quizId: 'q1', completedAt: new Date('2026-05-01'), score: { percentage: 64 }, topicBreakdown: [], analysis: {} }) }) }) });
  const svc = load();
  const out = await svc.findActivity('u1', 'quiz', 'product management');
  assert.equal(out.activityType, 'quiz');
  assert.equal(out.overallScore, 64);
});

test('findActivity: returns null when no match', async () => {
  stub(QUIZ, { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
  const svc = load();
  assert.equal(await svc.findActivity('u1', 'quiz', 'nonexistent'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassProgress.find.test.js`
Expected: FAIL — `svc.findActivity is not a function`.

- [ ] **Step 3: Implement**

```js
// src/services/v2/compassProgressService.js — add
const { canonicalize } = require('../diagnostic/topicTaxonomyService');

function fuzzyContains(haystack, needle) {
  if (!haystack || !needle) return false;
  const a = canonicalize(haystack), b = canonicalize(needle);
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const at = new Set(a.split('-')), bt = b.split('-');
  const overlap = bt.filter((t) => at.has(t)).length / Math.max(1, bt.length);
  return overlap >= 0.6;
}

async function findActivity(userId, type, query) {
  if (!query) return getLatestResult(userId, type);
  if (type === 'quiz') {
    const quizzes = await Quiz.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
    const match = quizzes.find((q) => fuzzyContains(q.topic, query));
    if (!match) return null;
    const attempt = await QuizAttempt.findOne({ userId, quizId: match._id, status: 'completed' }).sort({ completedAt: -1 }).lean();
    return attempt ? { ...module.exports._fmt.quizResult(attempt), title: `Quiz: ${match.topic}` } : null;
  }
  if (type === 'interview') {
    const sessions = await InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] } }).sort({ completedAt: -1 }).limit(25).lean();
    const match = sessions.find((s) => fuzzyContains(s.targetRole || s.interviewType, query)) || sessions[0];
    return match ? module.exports._fmt.interviewResult(match) : null;
  }
  // coding has no topic taxonomy; fall back to latest graded
  if (type === 'coding') return getLatestResult(userId, 'coding');
  return getLatestResult(userId, type);
}
module.exports.findActivity = findActivity;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassProgress.find.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/v2/compassProgressService.js src/test/v2/compassProgress.find.test.js
git commit -m "feat(compass): findActivity by topic/role with fuzzy match"
```

---

### Task 5: `getTopicDetail`, `listWeakTopics`, `listRecentActivity`

**Files:**
- Modify: `src/services/v2/compassProgressService.js`
- Create: `src/test/v2/compassProgress.topics.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassProgress.topics.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SVC = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const KP = path.resolve(__dirname, '../../models/KnowledgeProfile.js');
const USERCTX = path.resolve(__dirname, '../../services/userContextService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[SVC]; return require(SVC); }

test('listWeakTopics: returns weak topics sorted ascending by score', async () => {
  stub(KP, { findOne: () => ({ lean: async () => ({ topicMastery: [
    { topic: 'arrays', score: 82, trend: 'improving', quizzesTaken: 3 },
    { topic: 'recursion', score: 35, trend: 'declining', quizzesTaken: 2 },
    { topic: 'graphs', score: 50, trend: 'stable', quizzesTaken: 1 },
  ] }) }) });
  const svc = load();
  const out = await svc.listWeakTopics('u1', 5);
  assert.equal(out[0].topic, 'recursion');
  assert.equal(out.length, 2);   // arrays excluded (>=60)
});

test('getTopicDetail: merges mastery + misconceptions + due concepts', async () => {
  stub(KP, { findOne: () => ({ lean: async () => ({ topicMastery: [
    { topic: 'recursion', score: 35, level: 'beginner', trend: 'declining', quizzesTaken: 2, scoreHistory: [{ score: 30, date: new Date('2026-04-01') }] },
  ] }) }) });
  stub(USERCTX, { getUserContext: async () => ({ misconceptions: [{ tag: 'base_case', explanation: 'forgets base case', topics: ['recursion'] }], dueForReview: [{ concept: 'recursion-depth', topic: 'recursion' }] }) });
  const svc = load();
  const out = await svc.getTopicDetail('u1', 'recursion');
  assert.equal(out.topic, 'recursion');
  assert.equal(out.score, 35);
  assert.equal(out.misconceptions.length, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassProgress.topics.test.js`
Expected: FAIL — `svc.listWeakTopics is not a function`.

- [ ] **Step 3: Implement**

```js
// src/services/v2/compassProgressService.js — add

async function listWeakTopics(userId, limit = 5) {
  const kp = await KnowledgeProfile.findOne({ userId }).lean();
  return (kp?.topicMastery || [])
    .filter((t) => typeof t.score === 'number' && t.score < 60 && (t.quizzesTaken || 0) >= 1)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((t) => ({ topic: t.topic, score: t.score, trend: t.trend || 'stable', assessedBy: ['quiz'] }));
}

async function getTopicDetail(userId, topic) {
  const [kp, deep] = await Promise.all([
    KnowledgeProfile.findOne({ userId }).lean(),
    safe(() => userContextService.getUserContext(userId), null),
  ]);
  const tm = (kp?.topicMastery || []).find((t) => fuzzyContains(t.topic, topic));
  const misc = (deep?.misconceptions || []).filter((m) => (m.topics || []).some((tp) => fuzzyContains(tp, topic)) || fuzzyContains(m.recentTopic || '', topic))
    .map((m) => ({ tag: m.tag, explanation: m.explanation }));
  const due = (deep?.dueForReview || []).filter((d) => fuzzyContains(d.topic || d.concept || '', topic)).map((d) => d.concept).filter(Boolean);
  return {
    topic: tm?.topic || topic,
    score: tm?.score ?? null, level: tm?.level || null, trend: tm?.trend || null,
    history: (tm?.scoreHistory || []).slice(-5).map((h) => ({ score: h.score, date: module.exports._fmt.fmtDate(h.date) })),
    relatedActivities: [],
    misconceptions: misc.slice(0, 3),
    dueConcepts: due.slice(0, 5),
  };
}

async function listRecentActivity(userId, limit = 8, type = null) {
  // Reuse the merged timeline the /you/activities route builds. If a shared
  // builder isn't yet extracted, assemble a lightweight merge here.
  const items = [];
  const [quizzes, interviews] = await Promise.all([
    safe(() => QuizAttempt.find({ userId, status: 'completed' }).sort({ completedAt: -1 }).limit(limit).lean(), []),
    safe(() => InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] } }).sort({ completedAt: -1 }).limit(limit).lean(), []),
  ]);
  for (const q of quizzes) items.push({ type: 'quiz', title: 'Quiz', score: q.score?.percentage ?? null, date: module.exports._fmt.fmtDate(q.completedAt) });
  for (const i of interviews) items.push({ type: 'interview', title: (i.interviewType || 'interview').replace(/_/g, ' '), score: i.evaluation?.overallScore ?? null, date: module.exports._fmt.fmtDate(i.completedAt) });
  const filtered = type ? items.filter((x) => x.type === type) : items;
  return filtered.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
}

module.exports.listWeakTopics = listWeakTopics;
module.exports.getTopicDetail = getTopicDetail;
module.exports.listRecentActivity = listRecentActivity;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassProgress.topics.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/v2/compassProgressService.js src/test/v2/compassProgress.topics.test.js
git commit -m "feat(compass): getTopicDetail, listWeakTopics, listRecentActivity"
```

## Phase 2 — Read-only tools

### Task 6: `compassTools.js` — tool catalogue + dispatcher

**Files:**
- Create: `src/services/v2/compassTools.js`
- Create: `src/test/v2/compassTools.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassTools.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const TOOLS_PATH = path.resolve(__dirname, '../../services/v2/compassTools.js');
const PROGRESS = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[TOOLS_PATH]; return require(TOOLS_PATH); }

test('TOOLS: exposes exactly the six read-only tools', () => {
  stub(PROGRESS, {});
  const { TOOLS } = load();
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ['explain_readiness', 'find_activity', 'get_latest_result', 'get_topic_detail', 'list_recent_activity', 'list_weak_topics']);
});

test('dispatch: routes get_latest_result to the service and emits an activity_result card', async () => {
  stub(PROGRESS, { getLatestResult: async (uid, type) => ({ activityType: type, title: 'X', overallScore: 72, scoreLabel: '72/100', dimensions: [], highlights: { strengths: [], improvements: [] }, date: null }) });
  const { dispatch } = load();
  const r = await dispatch({ userId: 'u1', name: 'get_latest_result', input: { activity_type: 'interview' } });
  assert.equal(r.ok, true);
  assert.equal(r.card.type, 'activity_result');
  assert.equal(r.card.payload.overallScore, 72);
  assert.match(r.output, /72/);
});

test('dispatch: list_weak_topics wraps payload as { topics }', async () => {
  stub(PROGRESS, { listWeakTopics: async () => [{ topic: 'recursion', score: 35, trend: 'declining', assessedBy: ['quiz'] }] });
  const { dispatch } = load();
  const r = await dispatch({ userId: 'u1', name: 'list_weak_topics', input: {} });
  assert.equal(r.card.type, 'weak_topics');
  assert.equal(r.card.payload.topics[0].topic, 'recursion');
});

test('dispatch: never throws — service error becomes ok:false with error output', async () => {
  stub(PROGRESS, { explainReadiness: async () => { throw new Error('db down'); } });
  const { dispatch } = load();
  const r = await dispatch({ userId: 'u1', name: 'explain_readiness', input: {} });
  assert.equal(r.ok, false);
  assert.equal(r.card, null);
  assert.match(r.output, /could not/i);
});

test('dispatch: unknown tool → ok:false', async () => {
  stub(PROGRESS, {});
  const { dispatch } = load();
  const r = await dispatch({ userId: 'u1', name: 'nope', input: {} });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassTools.test.js`
Expected: FAIL — `Cannot find module '.../compassTools.js'`.

- [ ] **Step 3: Implement**

```js
// src/services/v2/compassTools.js
'use strict';

/**
 * Compass read-only retrieval tools.
 *
 * Each tool maps to a compassProgressService function. userId is injected by
 * the orchestrator from the authenticated request — the model NEVER supplies it,
 * so a tool can only ever read the calling user's own data. Every tool is
 * read-only and the dispatcher never throws (errors become {ok:false}).
 */

const progress = require('./compassProgressService');

const TOOLS = [
  { name: 'explain_readiness',
    description: "Explain the learner's current readiness score: why it's at that value, which competencies/topics drag it down, and the gap to their target. Use for 'why am I stuck at X%'.",
    input_schema: { type: 'object', properties: {} } },
  { name: 'get_latest_result',
    description: "Get the learner's most recent result for an activity type with its detailed breakdown. Use for 'how did I do on my latest interview / coding assessment / quiz / competition'.",
    input_schema: { type: 'object', properties: { activity_type: { type: 'string', enum: ['quiz', 'interview', 'coding', 'competition', 'content'] } }, required: ['activity_type'] } },
  { name: 'find_activity',
    description: "Find a specific past activity by topic or role and return its breakdown. Use for 'how did I do on the product management quiz' or 'the Google technical interview'.",
    input_schema: { type: 'object', properties: { activity_type: { type: 'string', enum: ['quiz', 'interview', 'coding', 'competition', 'content'] }, query: { type: 'string' } }, required: ['activity_type', 'query'] } },
  { name: 'get_topic_detail',
    description: 'Deep dive on one topic: mastery score, level, trend, history, related misconceptions, and review items. Use when the learner asks about a specific topic.',
    input_schema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } },
  { name: 'list_weak_topics',
    description: "List the learner's weakest topics, lowest first. Use for 'what are my weakest topics'.",
    input_schema: { type: 'object', properties: { limit: { type: 'integer' } } } },
  { name: 'list_recent_activity',
    description: "List the learner's recent activity across all types. Use for 'what have I been working on'.",
    input_schema: { type: 'object', properties: { limit: { type: 'integer' }, type: { type: 'string' } } } },
];

async function dispatch({ userId, name, input = {} }) {
  try {
    let data;
    let card = null;
    switch (name) {
      case 'explain_readiness':
        data = await progress.explainReadiness(userId);
        card = data ? { type: 'readiness_explanation', payload: data } : null;
        break;
      case 'get_latest_result':
        data = await progress.getLatestResult(userId, input.activity_type);
        card = data ? { type: 'activity_result', payload: data } : null;
        break;
      case 'find_activity':
        data = await progress.findActivity(userId, input.activity_type, input.query);
        card = data ? { type: 'activity_result', payload: data } : null;
        break;
      case 'get_topic_detail':
        data = await progress.getTopicDetail(userId, input.topic);
        card = data ? { type: 'topic_detail', payload: data } : null;
        break;
      case 'list_weak_topics':
        data = await progress.listWeakTopics(userId, input.limit || 5);
        card = { type: 'weak_topics', payload: { topics: data || [] } };
        break;
      case 'list_recent_activity':
        data = await progress.listRecentActivity(userId, input.limit || 8, input.type || null);
        card = { type: 'recent_activity', payload: { items: data || [] } };
        break;
      default:
        return { ok: false, output: JSON.stringify({ error: `unknown tool ${name}` }), card: null };
    }
    return { ok: true, output: JSON.stringify(data == null ? { result: null } : data), card };
  } catch (err) {
    console.warn('[compassTools] dispatch failed', name, err.message);
    return { ok: false, output: JSON.stringify({ error: 'could not retrieve that right now' }), card: null };
  }
}

module.exports = { TOOLS, dispatch };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassTools.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/v2/compassTools.js src/test/v2/compassTools.test.js
git commit -m "feat(compass): read-only retrieval tools + dispatcher"
```

---

## Phase 3 — Orchestrator integration

### Task 7: Fix `buildUserContext` (real readiness + topicMastery)

**Why:** Today `buildUserContext` reads `plan.readinessScore` (never set on the Plan schema → `undefined`) and `knowledge.topicProfiles` (legacy map; live docs use `topicMastery`). Compass therefore doesn't reliably know readiness or mastery. Fix both and expose `buildUserContext` for testing.

**Files:**
- Modify: `src/services/v2/compassOrchestrator.js:44-52` (requires), `:175-220` (buildUserContext), `:226-266` (buildSystemContext)
- Create: `src/test/v2/compassOrchestrator.context.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassOrchestrator.context.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const READINESS = path.resolve(__dirname, '../../services/readiness/readinessService.js');
const USER = path.resolve(__dirname, '../../models/User.js');
const UO = path.resolve(__dirname, '../../models/UserObjective.js');
const PLAN = path.resolve(__dirname, '../../models/Plan.js');
const KP = path.resolve(__dirname, '../../models/KnowledgeProfile.js');
const USERCTX = path.resolve(__dirname, '../../services/userContextService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }

test('buildUserContext: reads mastery from topicMastery and readiness from getServedReadiness', async () => {
  stub(USER, { findById: () => ({ select: () => ({ lean: async () => ({ firstName: 'Nirpeksh' }) }) }) });
  stub(UO, { findOne: () => ({ lean: async () => null }) });
  stub(PLAN, { findOne: () => ({ lean: async () => ({ currentWeek: 2, totalWeeks: 6, tasks: [] }) }) });
  stub(KP, { findOne: () => ({ lean: async () => ({ topicMastery: [
    { topic: 'arrays', score: 82, trend: 'improving', quizzesTaken: 3 },
    { topic: 'recursion', score: 35, trend: 'declining', quizzesTaken: 2 },
  ] }) }) });
  stub(USERCTX, { getUserContext: async () => null });
  stub(READINESS, { getServedReadiness: async () => ({ value: 70, target: 80, source: 'knowledge', trend: 'stable', draggers: [] }) });

  const orch = load();
  const ctx = await orch.buildUserContext('u1');
  assert.equal(ctx.readiness.value, 70);
  assert.equal(ctx.knowledge.strongTopics[0].topic, 'arrays');
  assert.equal(ctx.knowledge.weakTopics[0].topic, 'recursion');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassOrchestrator.context.test.js`
Expected: FAIL — `orch.buildUserContext is not a function` (not exported yet) or assertion fails on `ctx.readiness`.

- [ ] **Step 3: Implement**

Add the require near the top (after line 51):

```js
const readinessService = require('../readiness/readinessService');
```

Replace `buildUserContext` (lines 175-220) with:

```js
async function buildUserContext(userId) {
  const [user, objective, plan, knowledge, deepContext, readiness] = await Promise.all([
    User.findById(userId).select('firstName education workExperience').lean(),
    UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
    Plan.findOne({ userId, status: { $in: ['active', 'ready'] } }).lean(),
    KnowledgeProfile.findOne({ userId }).lean(),
    userContextService.getUserContext(userId).catch(() => null),
    readinessService.getServedReadiness(userId).catch(() => null),   // real served readiness
  ]);

  // Live mastery model is topicMastery[] (array), not the legacy topicProfiles map.
  const topicMastery = Array.isArray(knowledge?.topicMastery)
    ? knowledge.topicMastery
        .filter((t) => typeof t.score === 'number')
        .map((t) => ({ topic: t.topic, mastery: t.score, trend: t.trend || 'stable' }))
        .sort((a, b) => b.mastery - a.mastery)
    : [];

  return {
    user: { name: user?.firstName || 'there' },
    objective: objective ? {
      type: objective.objectiveType, specifics: objective.specifics,
      timeline: objective.timeline, targetDate: objective.targetDate, currentLevel: objective.currentLevel,
    } : null,
    plan: plan ? {
      currentWeek: plan.currentWeek, totalWeeks: plan.totalWeeks,
      tasksDoneThisWeek: (plan.tasks || []).filter((t) => t.weekNumber === plan.currentWeek && t.completedAt).length,
      tasksTotalThisWeek: (plan.tasks || []).filter((t) => t.weekNumber === plan.currentWeek).length,
    } : null,
    readiness: readiness ? { value: readiness.value, target: readiness.target, source: readiness.source } : null,
    knowledge: {
      strongTopics: topicMastery.slice(0, 3),
      weakTopics: topicMastery.slice(-3).reverse(),
    },
    deep: deepContext ? {
      misconceptions: (deepContext.misconceptions || []).slice(0, 3),
      dueForReview: (deepContext.dueForReview || []).slice(0, 3),
      recentTopics: (deepContext.recentTopicsTouched || []).slice(0, 5),
      recentTutor: (deepContext.recentAITutor?.topicsCovered || []).slice(0, 3),
      lastTutorQs: (deepContext.recentAITutor?.openQuestions || []).slice(0, 2),
    } : null,
  };
}
```

In `buildSystemContext` (lines 234-236), replace the plan-readiness line so it reads from `ctx.readiness` instead of the removed `ctx.plan.readiness`:

```js
  if (ctx.plan) {
    lines.push(`Plan progress: week ${ctx.plan.currentWeek}/${ctx.plan.totalWeeks}, ${ctx.plan.tasksDoneThisWeek}/${ctx.plan.tasksTotalThisWeek} tasks done this week.`);
  }
  if (ctx.readiness) {
    lines.push(`Current readiness: ${ctx.readiness.value}% (target ${ctx.readiness.target}%).`);
  }
```

At the bottom of the file, add `buildUserContext` to the exports object (e.g. `module.exports = { handle, getBudgetUsage, /* …existing… */ buildUserContext };`).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassOrchestrator.context.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/services/v2/compassOrchestrator.js src/test/v2/compassOrchestrator.context.test.js
git commit -m "fix(compass): real readiness + topicMastery in buildUserContext"
```

---

### Task 8: `callLLMWithTools` — the tool-use loop

**Files:**
- Modify: `src/services/v2/compassOrchestrator.js` (add requires + `callLLMWithTools`, export it)
- Create: `src/test/v2/compassOrchestrator.toolloop.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassOrchestrator.toolloop.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const ANTHROPIC = path.resolve(__dirname, '../../config/anthropic.js');
const REDIS = path.resolve(__dirname, '../../config/redis.js');
const TOOLS = path.resolve(__dirname, '../../services/v2/compassTools.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }

function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async (k, n) => { const v = (m.get(k) || 0) - n; m.set(k, v); return v; }, expire: async () => 1, get: async (k) => String(m.get(k) || 0) }; }

test('callLLMWithTools: runs one tool round then returns final text + cards', async () => {
  stub(REDIS, fakeRedis());
  let call = 0;
  stub(ANTHROPIC, { messages: { create: async () => {
    call += 1;
    if (call === 1) return { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'get_latest_result', input: { activity_type: 'interview' } }] };
    return { stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 12 }, content: [{ type: 'text', text: 'You scored 72 on your last interview — structure was strong.' }] };
  } } });
  stub(TOOLS, { TOOLS: [{ name: 'get_latest_result' }], dispatch: async () => ({ ok: true, output: '{"overallScore":72}', card: { type: 'activity_result', payload: { overallScore: 72 } } }) });

  const orch = load();
  const out = await orch.callLLMWithTools({ userId: 'u1', systemPrompt: 'sys', userPrompt: 'how did my last interview go?', history: [] });
  assert.match(out.text, /72/);
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].type, 'activity_result');
  assert.equal(call, 2);
});

test('callLLMWithTools: dedupes cards by type and caps at 2', async () => {
  stub(REDIS, fakeRedis());
  let call = 0;
  stub(ANTHROPIC, { messages: { create: async () => {
    call += 1;
    if (call === 1) return { stop_reason: 'tool_use', usage: {}, content: [
      { type: 'tool_use', id: 'a', name: 'get_latest_result', input: { activity_type: 'quiz' } },
      { type: 'tool_use', id: 'b', name: 'get_latest_result', input: { activity_type: 'interview' } },
      { type: 'tool_use', id: 'c', name: 'list_weak_topics', input: {} },
    ] };
    return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'done' }] };
  } } });
  stub(TOOLS, { TOOLS: [], dispatch: async ({ name }) => ({ ok: true, output: '{}', card: { type: name === 'list_weak_topics' ? 'weak_topics' : 'activity_result', payload: {} } }) });
  const orch = load();
  const out = await orch.callLLMWithTools({ userId: 'u1', systemPrompt: 's', userPrompt: 'p', history: [] });
  assert.equal(out.cards.length, 2);                    // capped
  assert.deepEqual(out.cards.map((c) => c.type), ['activity_result', 'weak_topics']); // deduped by type
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassOrchestrator.toolloop.test.js`
Expected: FAIL — `orch.callLLMWithTools is not a function`.

- [ ] **Step 3: Implement**

Add requires (top of file, after the readinessService require from Task 7):

```js
const compassTools = require('./compassTools');
const compassProgress = require('./compassProgressService');
const COMPASS_MAX_TOOL_ITERATIONS = 5;
```

Add the function (place it right after `callLLM`, near line 459):

```js
/**
 * Tool-enabled LLM call. Mirrors compassCoder.turn(): loop calling the model
 * with read-only Compass tools; on stop_reason='tool_use', dispatch each tool,
 * feed results back, repeat (capped at COMPASS_MAX_TOOL_ITERATIONS). Collects
 * the cards emitted by invoked tools (deduped by type, capped at 2).
 */
async function callLLMWithTools({ userId, systemPrompt, userPrompt, history = [], maxTokens = COMPASS_MAX_TOKENS }) {
  // Tool loops burn more than a single chat turn — reserve 2x maxTokens headroom.
  const estimatedTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4) + maxTokens * 2;
  const allowed = await checkAndIncrementBudget(userId, estimatedTokens);
  if (!allowed) {
    console.warn(`[compass] user ${userId} hit daily token cap (tools)`);
    return { text: null, cards: [], capped: true };
  }

  const messages = [];
  for (const h of history.slice(-8)) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    if (typeof h.content === 'string' && h.content.trim()) messages.push({ role, content: h.content });
  }
  messages.push({ role: 'user', content: userPrompt });

  const cards = [];
  let totalIn = 0;
  let totalOut = 0;
  let finalText = '';
  try {
    for (let iter = 0; iter < COMPASS_MAX_TOOL_ITERATIONS; iter++) {
      const response = await anthropic.messages.create({
        model: COMPASS_MODEL, max_tokens: maxTokens, temperature: COMPASS_TEMPERATURE,
        system: systemPrompt, messages, tools: compassTools.TOOLS,
      });
      totalIn += response.usage?.input_tokens || 0;
      totalOut += response.usage?.output_tokens || 0;
      messages.push({ role: 'assistant', content: response.content });

      const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text) finalText = text;
      if (response.stop_reason !== 'tool_use') break;

      const toolUses = (response.content || []).filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUses) {
        const r = await compassTools.dispatch({ userId, name: block.name, input: block.input });
        if (r.card) cards.push(r.card);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: r.output, is_error: !r.ok });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    const actual = totalIn + totalOut;
    await adjustBudget(userId, actual - estimatedTokens);

    const seen = new Set();
    const deduped = [];
    for (const c of cards) {
      if (seen.has(c.type)) continue;
      seen.add(c.type); deduped.push(c);
      if (deduped.length >= 2) break;
    }
    return { text: finalText || null, cards: deduped, capped: false, tokensIn: totalIn, tokensOut: totalOut };
  } catch (err) {
    await adjustBudget(userId, -estimatedTokens);
    console.error('[compass] tool-loop LLM error', err.message);
    return { text: null, cards: [], capped: false, error: err.message };
  }
}
```

Add `callLLMWithTools` to the module exports object.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassOrchestrator.toolloop.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/v2/compassOrchestrator.js src/test/v2/compassOrchestrator.toolloop.test.js
git commit -m "feat(compass): tool-use loop (callLLMWithTools) with card collection"
```

---

### Task 9: Wire tools + snapshot into `conversation()` and surface `output.cards`

**Note on response shape:** the route returns `{ success, data: <handle() result> }` and `handle()` returns `{ mode, output: {...} }`. The iOS envelope decodes `{ mode, output }`. So cards live at **`output.cards`** (next to `output.reply`/`output.followups`), NOT `data.cards`. (The spec's "data.cards" shorthand resolves to this.)

**Files:**
- Modify: `src/services/v2/compassOrchestrator.js` `conversation()` (lines 514-573) + export it
- Create: `src/test/v2/compassOrchestrator.conversation.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassOrchestrator.conversation.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const ANTHROPIC = path.resolve(__dirname, '../../config/anthropic.js');
const REDIS = path.resolve(__dirname, '../../config/redis.js');
const TOOLS = path.resolve(__dirname, '../../services/v2/compassTools.js');
const PROGRESS = path.resolve(__dirname, '../../services/v2/compassProgressService.js');
const CONV = path.resolve(__dirname, '../../models/CompassConversation.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }
function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async (k, n) => { const v = (m.get(k) || 0) - n; m.set(k, v); return v; }, expire: async () => 1, get: async () => '0' }; }

test('conversation: returns reply + cards from a tool round, injecting the snapshot', async () => {
  stub(REDIS, fakeRedis());
  stub(CONV, {}); // appendToThread is best-effort; stubbed model makes it no-op via its try/catch
  stub(PROGRESS, { getSnapshot: async () => ({ readiness: { value: 70, target: 80 } }), renderSnapshot: () => 'Readiness: 70% (target 80%).' });
  let call = 0;
  stub(ANTHROPIC, { messages: { create: async ({ system }) => {
    call += 1;
    assert.match(system, /Readiness: 70%/);   // snapshot injected
    assert.match(system, /NEVER state a number/i); // never-invent rule injected
    if (call === 1) return { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't', name: 'explain_readiness', input: {} }] };
    return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: "You're at 70% because two competencies are below target." }] };
  } } });
  stub(TOOLS, { TOOLS: [], dispatch: async () => ({ ok: true, output: '{"value":70}', card: { type: 'readiness_explanation', payload: { value: 70, target: 80 } } }) });

  const orch = load();
  const res = await orch.conversation({ ctx: {}, systemPrompt: 'You are Compass.', userId: 'u1', message: 'why am I stuck at 70?', history: [{ role: 'user', content: 'hi' }] });
  assert.match(res.output.reply, /70%/);
  assert.equal(res.output.cards[0].type, 'readiness_explanation');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassOrchestrator.conversation.test.js`
Expected: FAIL — `orch.conversation is not a function`.

- [ ] **Step 3: Implement**

Rewrite `conversation()` (lines 514-573) to build the snapshot block, call `callLLMWithTools`, and surface cards. Full replacement:

```js
async function conversation({ ctx, systemPrompt, userId, message, history = [] }) {
  if (!message || typeof message !== 'string') {
    return { mode: 'conversation', output: { reply: 'Tell me what you need.', followups: [], cards: [] } };
  }

  await appendToThread(userId, 'user', message, { mode: 'conversation' });

  let effectiveHistory = history;
  if (!history || history.length === 0) {
    try {
      const thread = await getOrCreateActiveThread(userId);
      effectiveHistory = (thread?.messages || []).slice(-8, -1).map((m) => ({ role: m.role, content: m.content }));
    } catch (_) {}
  }

  // Live progress snapshot + the hard never-invent rule + tool guidance.
  let snapshotBlock = '';
  try {
    const snap = await compassProgress.getSnapshot(userId);
    const rendered = compassProgress.renderSnapshot(snap);
    if (rendered) snapshotBlock = `\n\n--- CURRENT PROGRESS SNAPSHOT (live data) ---\n${rendered}\n--- END SNAPSHOT ---`;
  } catch (_) {}

  const extended = systemPrompt + snapshotBlock +
    `\n\nYou can call read-only tools to look up specifics (a latest result, a named activity, a topic, weak topics, the readiness breakdown, recent activity). Use them for ANY question about the learner's performance or progress.` +
    `\nNEVER state a number, score, or result you did not get from the snapshot above or from a tool. If you don't have it, call a tool — or say you'll check.` +
    `\n\nReply rules:\n- Be conversational and concise (3-5 sentences max unless the question genuinely requires more).\n- Ground answers in the learner's objective and recent context.\n- End with up to 3 short follow-up suggestions as a JSON code block: \`\`\`json\n{"followups":["…","…","…"]}\n\`\`\` — these will be parsed and shown as chips.\n- Refuse off-topic / harmful / professional-advice requests politely; redirect to learning.`;

  const llmResult = await callLLMWithTools({ userId, systemPrompt: extended, userPrompt: message, history: effectiveHistory, maxTokens: COMPASS_MAX_TOKENS });
  const { text, cards = [], capped, tokensIn, tokensOut } = llmResult;

  if (capped) {
    const reply = "You've hit today's free Compass usage. Try again tomorrow or upgrade for higher limits.";
    await appendToThread(userId, 'assistant', reply, { mode: 'conversation' });
    return { mode: 'conversation', output: { reply, followups: [], cards: [] } };
  }

  if (!text) {
    const reply = 'I had trouble thinking that through just now. Try again in a moment?';
    await appendToThread(userId, 'assistant', reply, { mode: 'conversation', followups: ['Retry', 'Try something else'] });
    return { mode: 'conversation', output: { reply, followups: ['Retry', 'Try something else'], cards: [] } };
  }

  let reply = text;
  let followups = [];
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonMatch) {
    try { const parsed = JSON.parse(jsonMatch[1]); if (Array.isArray(parsed.followups)) followups = parsed.followups.slice(0, 3); } catch (_) {}
    reply = text.replace(jsonMatch[0], '').trim();
  }

  await appendToThread(userId, 'assistant', reply, { mode: 'conversation', followups, cards, tokensIn, tokensOut });
  return { mode: 'conversation', output: { reply, followups, cards } };
}
```

Add `conversation` to the module exports object.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassOrchestrator.conversation.test.js`
Expected: PASS (1 test).

Also run the full Compass test set to confirm no regressions:
Run: `node --test --test-force-exit src/test/v2/*.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/v2/compassOrchestrator.js src/test/v2/compassOrchestrator.conversation.test.js
git commit -m "feat(compass): conversation uses snapshot + tools, returns output.cards"
```

---

## Phase 4 — Persistence & API contract

### Task 10: Persist `cards` on the message + return them in history

**Files:**
- Modify: `src/models/CompassConversation.js:13-24` (add `cards`)
- Modify: `src/services/v2/compassOrchestrator.js` `appendToThread` (lines 76-102) to persist `opts.cards`
- Modify: `src/routes/v2/you.js` compass-history handler (around `:795-901`) to include `cards` per message
- Create: `src/test/v2/compassConversation.cards.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassConversation.cards.test.js
'use strict';
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const path = require('path');
const CONV = path.resolve(__dirname, '../../models/CompassConversation.js');

test('CompassConversation message accepts a cards array (additive, optional)', () => {
  delete require.cache[CONV];
  const CompassConversation = require(CONV);
  const doc = new CompassConversation({
    userId: new mongoose.Types.ObjectId(),
    messages: [{ role: 'assistant', content: 'hi', mode: 'conversation', cards: [{ type: 'readiness_explanation', payload: { value: 70 } }] }],
  });
  const err = doc.validateSync();
  assert.equal(err, undefined, err && err.message);
  assert.equal(doc.messages[0].cards[0].type, 'readiness_explanation');
  assert.equal(doc.messages[0].cards[0].payload.value, 70);
});

test('CompassConversation message is valid with no cards (back-compat)', () => {
  delete require.cache[CONV];
  const CompassConversation = require(CONV);
  const doc = new CompassConversation({ userId: new mongoose.Types.ObjectId(), messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(doc.validateSync(), undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassConversation.cards.test.js`
Expected: FAIL — `cards[0]` is undefined (schema strips the unknown field).

- [ ] **Step 3: Implement**

In `src/models/CompassConversation.js`, add a `cards` field to `compassMessageSchema` (after `followups`, line 17):

```js
  followups: [String],            // suggested follow-ups for the last assistant turn
  // Rich answer cards projected from invoked Compass tools (Progress Intelligence).
  // Optional + additive — old messages decode unchanged. Mixed payload per type.
  cards: [{
    _id: false,
    type: { type: String },                                  // readiness_explanation | activity_result | topic_detail | weak_topics | recent_activity
    payload: { type: mongoose.Schema.Types.Mixed },
  }],
```

In `appendToThread` (orchestrator, the `thread.messages.push({...})` block ~line 80), add:

```js
      followups: opts.followups || [],
      cards: opts.cards || [],
```

In the compass-history handler in `src/routes/v2/you.js` (the single-session transcript map that returns `messages`), include `cards` on each message object, e.g.:

```js
      messages: (session.messages || []).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content.slice(0, 4000) : '',
        mode: m.mode,
        followups: m.followups || [],
        cards: m.cards || [],          // NEW — so history can re-render cards
        createdAt: m.createdAt,
      })),
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassConversation.cards.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/models/CompassConversation.js src/services/v2/compassOrchestrator.js src/routes/v2/you.js src/test/v2/compassConversation.cards.test.js
git commit -m "feat(compass): persist + return answer cards on messages"
```

---

### Task 11: OpenAPI contract — `cards` + `CompassCard` schema

**Files:**
- Modify: `openapi.yaml` (Compass response schema + new `CompassCard` schema)
- Create: `src/test/v2/compassOpenapi.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassOpenapi.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('openapi.yaml declares the CompassCard schema and the five card types', () => {
  const yaml = fs.readFileSync(path.resolve(__dirname, '../../../openapi.yaml'), 'utf8');
  assert.match(yaml, /CompassCard:/);
  for (const t of ['readiness_explanation', 'activity_result', 'topic_detail', 'weak_topics', 'recent_activity']) {
    assert.ok(yaml.includes(t), `openapi.yaml should mention card type ${t}`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-force-exit src/test/v2/compassOpenapi.test.js`
Expected: FAIL — `CompassCard:` not found.

- [ ] **Step 3: Implement**

In `openapi.yaml`, under `components.schemas`, add:

```yaml
    CompassCard:
      type: object
      description: >
        A rich answer card projected from an invoked Compass Progress tool.
        Clients render the payload by `type`; unknown types must be ignored.
      properties:
        type:
          type: string
          enum: [readiness_explanation, activity_result, topic_detail, weak_topics, recent_activity]
        payload:
          type: object
          additionalProperties: true
      required: [type, payload]
```

Then add `cards` to the Compass conversation response `output` object (find the schema backing `POST /api/v2/compass`'s `data.output`; add alongside `reply`/`followups`):

```yaml
        cards:
          type: array
          description: Rich answer cards for this turn (deduped by type, max 2). May be empty.
          items:
            $ref: '#/components/schemas/CompassCard'
```

Then regenerate the iOS OpenAPI client so the `APICompass…` models gain `cards` (use the project's existing generation command — check `package.json`/`Makefile`/`scripts/` for the openapi-generator invocation, e.g. `npm run generate:ios-client` or the documented codegen step).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-force-exit src/test/v2/compassOpenapi.test.js`
Expected: PASS (1 test).

Run the existing contract test to confirm nothing broke:
Run: `node --test --test-force-exit src/test/openapi-contract.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/test/v2/compassOpenapi.test.js
# include regenerated client if it lives in this repo
git commit -m "feat(compass): OpenAPI cards + CompassCard schema"
```

## Phase 5 — iOS (repo: `ScaleUpDemo-f`)

> iOS tests use XCTest in `Tests/UnitTests`, scheme `ScaleUp`. Run a unit test with Xcode ⌘U or:
> `xcodebuild test -scheme ScaleUp -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:ScaleUpUnitTests/CompassCardDecodingTests`
> (match the exact unit-test target/destination names in your project). SwiftUI views are verified by a clean build + Xcode preview + manual run.

### Task 12: Decode answer cards

**Files:**
- Create: `ScaleUp/Features/V2/Compass/CompassCard.swift`
- Modify: `ScaleUp/Features/V2/Compass/CompassViewModel.swift` (`CompassMessage` + `CompassOutput` + assistant-message construction)
- Create: `Tests/UnitTests/CompassCardDecodingTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// Tests/UnitTests/CompassCardDecodingTests.swift
import XCTest
@testable import ScaleUp

final class CompassCardDecodingTests: XCTestCase {
    func testDecodesActivityResultCard() throws {
        let json = """
        [{"type":"activity_result","payload":{"activityType":"interview","title":"placement technical","date":"2026-05-01","overallScore":72,"scoreLabel":"72/100","dimensions":[{"name":"communication","score":7,"feedback":"clear"}],"highlights":{"strengths":["structure"],"improvements":["depth"]}}}]
        """.data(using: .utf8)!
        let cards = try JSONDecoder().decode([CompassCard].self, from: json)
        XCTAssertEqual(cards.count, 1)
        guard case let .activityResult(p) = cards[0].payload else { return XCTFail("wrong payload") }
        XCTAssertEqual(p.overallScore, 72)
        XCTAssertEqual(p.dimensions.first?.name, "communication")
    }

    func testDecodesWeakTopicsCard() throws {
        let json = """
        [{"type":"weak_topics","payload":{"topics":[{"topic":"recursion","score":35,"trend":"declining","assessedBy":["quiz"]}]}}]
        """.data(using: .utf8)!
        let cards = try JSONDecoder().decode([CompassCard].self, from: json)
        guard case let .weakTopics(topics) = cards[0].payload else { return XCTFail() }
        XCTAssertEqual(topics.first?.topic, "recursion")
    }

    func testUnknownCardTypeDecodesToUnknownAndIsIgnorable() throws {
        let json = """
        [{"type":"future_card","payload":{"whatever":true}}]
        """.data(using: .utf8)!
        let cards = try JSONDecoder().decode([CompassCard].self, from: json)
        guard case .unknown = cards[0].payload else { return XCTFail("should be unknown") }
        XCTAssertEqual(cards[0].type, "future_card")
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run in Xcode (⌘U) or the `xcodebuild test` command above.
Expected: FAIL — `Cannot find 'CompassCard' in scope`.

- [ ] **Step 3: Implement the models**

```swift
// ScaleUp/Features/V2/Compass/CompassCard.swift
import Foundation

// Rich answer cards from Compass Progress Intelligence. Decoded by `type`;
// unknown types decode to `.unknown` and are rendered as nothing (forward-compatible).

enum CompassCardPayload {
    case readiness(CompassReadinessPayload)
    case activityResult(CompassActivityResultPayload)
    case topicDetail(CompassTopicDetailPayload)
    case weakTopics([CompassWeakTopic])
    case recentActivity([CompassActivityItem])
    case unknown
}

struct CompassCard: Decodable, Identifiable {
    let id = UUID()
    let type: String
    let payload: CompassCardPayload

    private enum CodingKeys: String, CodingKey { case type, payload }
    private struct WeakTopicsWrapper: Decodable { let topics: [CompassWeakTopic] }
    private struct RecentActivityWrapper: Decodable { let items: [CompassActivityItem] }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let t = try c.decode(String.self, forKey: .type)
        type = t
        switch t {
        case "readiness_explanation": payload = .readiness(try c.decode(CompassReadinessPayload.self, forKey: .payload))
        case "activity_result":       payload = .activityResult(try c.decode(CompassActivityResultPayload.self, forKey: .payload))
        case "topic_detail":          payload = .topicDetail(try c.decode(CompassTopicDetailPayload.self, forKey: .payload))
        case "weak_topics":           payload = .weakTopics((try c.decode(WeakTopicsWrapper.self, forKey: .payload)).topics)
        case "recent_activity":       payload = .recentActivity((try c.decode(RecentActivityWrapper.self, forKey: .payload)).items)
        default:                      payload = .unknown
        }
    }
}

struct CompassReadinessPayload: Decodable {
    let value: Double?; let target: Double?; let source: String?
    let distanceToTarget: Double?; let contributors: [Contributor]; let topDraggers: [Dragger]; let note: String
    struct Contributor: Decodable, Identifiable { let id = UUID(); let name: String; let score: Double?; let weight: Double?; let assessed: Bool
        private enum CodingKeys: String, CodingKey { case name, score, weight, assessed } }
    struct Dragger: Decodable, Identifiable { let id = UUID(); let name: String; let score: Double?; let weight: Double?
        private enum CodingKeys: String, CodingKey { case name, score, weight } }
}

struct CompassActivityResultPayload: Decodable {
    let activityType: String; let title: String; let date: String?
    let overallScore: Double?; let scoreLabel: String; let dimensions: [Dimension]; let highlights: Highlights
    struct Dimension: Decodable, Identifiable { let id = UUID(); let name: String; let score: Double?; let feedback: String?
        private enum CodingKeys: String, CodingKey { case name, score, feedback } }
    struct Highlights: Decodable { let strengths: [String]; let improvements: [String] }
}

struct CompassTopicDetailPayload: Decodable {
    let topic: String; let score: Double?; let level: String?; let trend: String?
    let history: [Point]; let misconceptions: [Misconception]; let dueConcepts: [String]
    struct Point: Decodable, Identifiable { let id = UUID(); let score: Double?; let date: String?
        private enum CodingKeys: String, CodingKey { case score, date } }
    struct Misconception: Decodable, Identifiable { let id = UUID(); let tag: String; let explanation: String
        private enum CodingKeys: String, CodingKey { case tag, explanation } }
}

struct CompassWeakTopic: Decodable, Identifiable {
    let id = UUID(); let topic: String; let score: Double?; let trend: String; let assessedBy: [String]
    private enum CodingKeys: String, CodingKey { case topic, score, trend, assessedBy }
}

struct CompassActivityItem: Decodable, Identifiable {
    let id = UUID(); let type: String; let title: String; let score: Double?; let date: String?
    private enum CodingKeys: String, CodingKey { case type, title, score, date }
}
```

- [ ] **Step 4: Wire into `CompassViewModel`**

In `CompassViewModel.swift`: add `cards` to the message and the decoded output, and pass cards when building the assistant message.

```swift
// 1. struct CompassMessage { ... } — add:
    var cards: [CompassCard] = []

// 2. private struct CompassOutput: Codable { ... } — add:
    let cards: [CompassCard]?

// 3. Where a conversation/coach reply builds the assistant CompassMessage
//    (the path that reads env.output.reply / output.followups), pass:
//      CompassMessage(role: .compass, text: reply, suggestedAction: out.suggestedAction, cards: out.cards ?? [])
```

(Find the existing assistant-append site by searching for `out.reply` / `output.reply` / `.followups` in `CompassViewModel.swift`; add `cards: out.cards ?? []` to that `CompassMessage(...)` initializer call.)

- [ ] **Step 5: Run to verify it passes**

Run the unit test (⌘U / `xcodebuild test …`).
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add ScaleUp/Features/V2/Compass/CompassCard.swift ScaleUp/Features/V2/Compass/CompassViewModel.swift Tests/UnitTests/CompassCardDecodingTests.swift
git commit -m "feat(compass/ios): decode Progress Intelligence answer cards"
```

---

### Task 13: Render the card views

**Files:**
- Create: `ScaleUp/Features/V2/Compass/CompassCardViews.swift`
- Modify: `ScaleUp/Features/V2/Compass/V2CompassView.swift` (`MessageView` assistant branch, lines ~645-663)

- [ ] **Step 1: Implement the card views**

```swift
// ScaleUp/Features/V2/Compass/CompassCardViews.swift
import SwiftUI

// Dispatcher — renders the right card view for a decoded payload.
struct CompassCardView: View {
    let card: CompassCard
    var body: some View {
        switch card.payload {
        case .readiness(let p):       CompassReadinessCard(payload: p)
        case .activityResult(let p):  CompassActivityResultCard(payload: p)
        case .topicDetail(let p):     CompassTopicDetailCard(payload: p)
        case .weakTopics(let topics): CompassWeakTopicsCard(topics: topics)
        case .recentActivity(let items): CompassRecentActivityCard(items: items)
        case .unknown:                EmptyView()
        }
    }
}

private struct CardShell<Content: View>: View {
    let title: String; let systemImage: String; @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: systemImage).font(.caption.weight(.semibold)).foregroundStyle(ColorTokens.gold)
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(ColorTokens.gold)
            }
            content()
        }
        .padding(12)
        .background(ColorTokens.gold.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(ColorTokens.gold.opacity(0.2), lineWidth: 1))
    }
}

private func scoreText(_ v: Double?) -> String { v == nil ? "—" : String(Int(v!.rounded())) }

struct CompassReadinessCard: View {
    let payload: CompassReadinessPayload
    var body: some View {
        CardShell(title: "Readiness", systemImage: "scope") {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(scoreText(payload.value))%").font(.title2.weight(.bold)).foregroundStyle(ColorTokens.textPrimary)
                if let t = payload.target { Text("/ target \(scoreText(t))%").font(.caption).foregroundStyle(ColorTokens.textSecondary) }
            }
            ForEach(payload.topDraggers) { d in
                HStack { Text(d.name).font(.subheadline).foregroundStyle(ColorTokens.textPrimary); Spacer(); Text("\(scoreText(d.score))%").font(.subheadline).foregroundStyle(ColorTokens.textSecondary) }
            }
            if !payload.note.isEmpty { Text(payload.note).font(.caption).foregroundStyle(ColorTokens.textSecondary) }
        }
    }
}

struct CompassActivityResultCard: View {
    let payload: CompassActivityResultPayload
    var body: some View {
        CardShell(title: payload.title, systemImage: "checkmark.seal") {
            Text(payload.scoreLabel).font(.title3.weight(.bold)).foregroundStyle(ColorTokens.textPrimary)
            ForEach(payload.dimensions) { dim in
                HStack { Text(dim.name.capitalized).font(.subheadline).foregroundStyle(ColorTokens.textPrimary); Spacer(); Text(scoreText(dim.score)).font(.subheadline).foregroundStyle(ColorTokens.textSecondary) }
            }
            if let imp = payload.highlights.improvements.first { Text("Improve: \(imp)").font(.caption).foregroundStyle(ColorTokens.textSecondary) }
        }
    }
}

struct CompassTopicDetailCard: View {
    let payload: CompassTopicDetailPayload
    var body: some View {
        CardShell(title: payload.topic.capitalized, systemImage: "chart.line.uptrend.xyaxis") {
            HStack(spacing: 8) {
                Text("\(scoreText(payload.score))%").font(.title3.weight(.bold)).foregroundStyle(ColorTokens.textPrimary)
                if let level = payload.level { Text(level.capitalized).font(.caption).foregroundStyle(ColorTokens.textSecondary) }
                if let trend = payload.trend { Text(trend).font(.caption).foregroundStyle(ColorTokens.textSecondary) }
            }
            ForEach(payload.misconceptions) { m in Text("• \(m.explanation)").font(.caption).foregroundStyle(ColorTokens.textSecondary) }
        }
    }
}

struct CompassWeakTopicsCard: View {
    let topics: [CompassWeakTopic]
    var body: some View {
        CardShell(title: "Weakest topics", systemImage: "exclamationmark.triangle") {
            ForEach(topics) { t in
                HStack { Text(t.topic.capitalized).font(.subheadline).foregroundStyle(ColorTokens.textPrimary); Spacer(); Text("\(scoreText(t.score))%").font(.subheadline).foregroundStyle(ColorTokens.textSecondary) }
            }
        }
    }
}

struct CompassRecentActivityCard: View {
    let items: [CompassActivityItem]
    var body: some View {
        CardShell(title: "Recent activity", systemImage: "clock.arrow.circlepath") {
            ForEach(items) { it in
                HStack { Text("\(it.type.capitalized): \(it.title)").font(.subheadline).foregroundStyle(ColorTokens.textPrimary).lineLimit(1); Spacer(); if let s = it.score { Text("\(scoreText(s))").font(.subheadline).foregroundStyle(ColorTokens.textSecondary) } }
            }
        }
    }
}
```

- [ ] **Step 2: Render cards in `MessageView`**

In `V2CompassView.swift`, the assistant branch of `MessageView` (the `VStack(alignment: .leading, spacing: 8)` containing the text bubble + the `suggestedActionCard`), add after the `suggestedActionCard` block (line ~662):

```swift
                    ForEach(message.cards) { card in
                        CompassCardView(card: card)
                    }
```

- [ ] **Step 3: Build to verify it compiles**

Run: `xcodebuild build -scheme ScaleUp -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Manual verification**

Launch the app, open Compass, and ask "why am I stuck at my readiness?" and "how did I do on my last interview?". Confirm a readiness card and an activity-result card render under the reply text. Ask "what have I done lately?" and confirm a recent-activity card. (Cards only appear when a tool is invoked; plain chat shows text only.)

- [ ] **Step 5: Commit**

```bash
git add ScaleUp/Features/V2/Compass/CompassCardViews.swift ScaleUp/Features/V2/Compass/V2CompassView.swift
git commit -m "feat(compass/ios): render Progress Intelligence answer cards"
```

---

### Task 14: Remove the resume-builder stub

**Files:**
- Delete: `ScaleUp/Features/V2/Compass/V2ResumeHomeView.swift`
- Modify: `ScaleUp/Features/V2/Compass/CompassViewModel.swift` (`CompassHomeRoute` enum + chip→route mapping)
- Modify: `ScaleUp/Features/V2/Compass/V2CompassView.swift` (`CompassQuickAction.all` + default suggestion chip + `presentedHome == .resume` sheet branch)

- [ ] **Step 1: Locate every reference**

Run: `grep -rn -i "resume" ScaleUp/Features/V2/Compass/`
Expected: hits in `V2ResumeHomeView.swift`, `CompassViewModel.swift` (`case resume`, the `"resume"` chip→route mapping), `V2CompassView.swift` (the `CompassQuickAction` labeled "Build my resume", the `"📄 Build my resume"` default suggestion, the `.resume` sheet case).

- [ ] **Step 2: Remove them**

- Delete the file `V2ResumeHomeView.swift`.
- In `CompassViewModel.swift`: remove `case resume` from `CompassHomeRoute`, and remove the mapping entry that routes the resume chip/label to `.resume`.
- In `V2CompassView.swift`: remove the `CompassQuickAction(... "Build my resume" ...)` element from `CompassQuickAction.all`; remove `"📄 Build my resume"` from the default suggestion-chip array; remove the `case .resume:` branch in the `presentedHome` sheet switch.

- [ ] **Step 3: Confirm backend has no resume action**

Run (backend repo): `grep -rni "resume" "/Users/nirpekshnandan/My Products/ScaleUpDemo/scaleup-backend/src/services/v2/" "/Users/nirpekshnandan/My Products/ScaleUpDemo/scaleup-backend/src/routes/v2/"`
Expected: no resume *action/route* in the orchestrator (only unrelated hits, if any). If a resume suggestion exists, remove it. (Expected: none.)

- [ ] **Step 4: Build to verify**

Run: `xcodebuild build -scheme ScaleUp -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: BUILD SUCCEEDED, and no "Build my resume" chip appears in Compass at runtime.

- [ ] **Step 5: Commit**

```bash
git add -A ScaleUp/Features/V2/Compass/
git commit -m "chore(compass/ios): remove resume-builder stub"
```

---

## Plan self-review — spec coverage map

| Spec section | Task(s) |
|---|---|
| `compassProgressService` + snapshot | Task 1 |
| Adaptive/decoupled readiness ("why 70") + shared `getServedReadiness` | Task 2 |
| Per-activity `get_latest_result` (all 6 types) | Task 3 |
| `find_activity` (PM quiz / named interview) | Task 4 |
| `get_topic_detail` / `list_weak_topics` / `list_recent_activity` | Task 5 |
| `compassTools` read-only tools + userId scoping + never-throw | Task 6 |
| Stale-context bug fix (readiness + topicMastery) | Task 7 |
| Tool-use loop + budget + card collection (dedupe/cap 2) | Task 8 |
| Snapshot injection + never-invent rule + `output.cards` | Task 9 |
| Card persistence + history re-render | Task 10 |
| OpenAPI `cards` + `CompassCard` + client regen | Task 11 |
| iOS card decode (graceful unknown) | Task 12 |
| iOS 5 card views + MessageView render | Task 13 |
| Resume-builder removal | Task 14 |

**Non-goals confirmed honored:** no mastery/readiness writes (all tools read-only); no new readiness math (consumes `getServedReadiness`); no voice/multimodal/Android-UI/proactive-push. **Known gotchas covered:** topic-key normalization via `canonicalize`+fuzzy (Task 4); coding excluded from topic joins (Tasks 3-4); single-source readiness (Task 2); `ChallengeAttempt` latest is a per-user scan (acceptable; noted in Task 3 via `competitionService`).

**Placeholder scan:** none — every code step shows full code; the two `NOTE` callouts (Task 2 require paths, Task 11 client-regen command) point to exact existing sources to match, not unfinished work.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-03-compass-progress-intelligence.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
