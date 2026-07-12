/**
 * Misconception Service — BUG-8 Phase 4 (+ agentic-layer #7: spaced re-checks)
 *
 * Records every distractor-tagged misconception the user picks. A
 * "misconception" is a labelled wrong answer (e.g. "treats_correlation_as_causation")
 * that captures the false belief behind a wrong pick — far more useful
 * than just "they got it wrong".
 *
 * #7 layers a verified spaced re-check on top: once a tag fires, it's
 * scheduled for re-checks at day 2/7/16. Each time the learner touches that
 * tag's topic again WITHOUT the misconception recurring, the check advances;
 * passing all three closes the item (a durable "you've got this" signal). A
 * recurrence at any point reopens a closed item and resets the clock.
 *
 * Public API:
 *   recordFromAttempt(userId, attempt, quiz, deps) — invoked once when a quiz is scored
 *   getRecurringPatterns(userId)                   — used by the Insights service
 *   getDueReviews(userId, limit, deps)              — open re-checks due now
 *   advanceReview(item, now)                        — pure mutator, exported for tests
 *   REVIEW_INTERVALS                                — exported for tests
 */

const MisconceptionLedger = require('../models/MisconceptionLedger');

const T = {
  RECURRING_MIN_COUNT: 3,        // need this many instances to call it "recurring"
  RECURRING_MIN_TOPICS: 2,       // and at least this many distinct topics for transfer-signal
  RECENCY_WINDOW_DAYS: 60,       // only consider entries with lastSeenAt within this window
};

const DAY_MS = 86400000;

// Stage N's due-gap in days. Index == the ledger item's reviewStage AFTER
// the increment that scheduled it (i.e. REVIEW_INTERVALS[0] is the gap
// before the FIRST re-check, scheduled the moment a tag fires).
const REVIEW_INTERVALS = [2, 7, 16];

function defaultDeps() {
  return {
    MisconceptionLedger,
    record: require('./agentDecisionService').record,
    isAgentEnabled: require('../config/agentFlags').isAgentEnabled,
  };
}

/**
 * Advance (or close) one ledger item's review clock. Mutates `item` in place.
 *
 * - closed (`closedAt` set) → no-op. Closed items don't re-enter the cycle
 *   except by recurrence (handled in recordFromAttempt, not here).
 * - not yet due (`nextReviewAt` missing, or `nextReviewAt > now`) → no-op.
 *   Boundary choice: `nextReviewAt === now` counts as DUE (inclusive) —
 *   early success shouldn't advance the clock, but the exact scheduled
 *   instant should fire, matching how the rest of the codebase treats
 *   `$lte: now` cutoffs (e.g. spacedRepetitionService.getDueConcepts).
 * - due → reviewStage += 1; if the new stage runs past the last interval,
 *   close (`closedAt = now`, `nextReviewAt = null`); else reschedule to
 *   `now + REVIEW_INTERVALS[reviewStage] days`.
 *
 * @returns {{ advanced: boolean, closed: boolean }}
 */
function advanceReview(item, now = new Date()) {
  if (!item) return { advanced: false, closed: false };
  if (item.closedAt || !item.nextReviewAt || item.nextReviewAt > now) {
    return { advanced: false, closed: false };
  }

  item.reviewStage = (item.reviewStage || 0) + 1;

  if (item.reviewStage >= REVIEW_INTERVALS.length) {
    item.closedAt = now;
    item.nextReviewAt = null;
    return { advanced: true, closed: true };
  }

  item.nextReviewAt = new Date(now.getTime() + REVIEW_INTERVALS[item.reviewStage] * DAY_MS);
  return { advanced: true, closed: false };
}

/**
 * After a quiz is scored, walk through wrong answers and bump the
 * ledger for any whose option carries a misconception tag.
 * Idempotent on re-scoring: we deliberately don't track "which attempts
 * already counted" because the cost of double-counting is small (one
 * extra count) and the cost of forgetting (silent drift) is bigger.
 *
 * #7 (flag-gated on `misconception_tutor`, additive):
 *   - a tag that fires this attempt gets (re)scheduled: reviewStage=0,
 *     nextReviewAt=+2d, closedAt=null (a recurrence reopens a closed item).
 *   - a tag whose topic this attempt touched WITHOUT firing gets its
 *     review clock advanced via advanceReview.
 *   - every verified closure records a ledger row via agentDecisionService,
 *     try/catch-guarded so a logging failure never breaks scoring.
 * With the flag off, behavior is byte-identical to pre-#7 code.
 */
async function recordFromAttempt(userId, attempt, quiz, deps = {}) {
  if (!attempt?.answers?.length || !quiz?.questions?.length) return;

  const { MisconceptionLedger: LedgerModel, record, isAgentEnabled } = { ...defaultDeps(), ...deps };
  const reviewEnabled = isAgentEnabled('misconception_tutor');

  // Group new firings by tag so we do one $set per tag rather than per question.
  const firings = new Map(); // tag -> { count, topics: Set, explanation, latestTopic }

  for (const answer of attempt.answers) {
    if (!answer || answer.isCorrect) continue;
    if (answer.selectedAnswer === 'skipped') continue;
    const q = quiz.questions[answer.questionIndex];
    if (!q?.options?.length) continue;
    const picked = q.options.find(o => o.label === answer.selectedAnswer);
    const tag = picked?.misconception?.tag;
    if (!tag) continue;

    const topic = (q.concept || quiz.topic || '').toString().toLowerCase();
    const existing = firings.get(tag) || { count: 0, topics: new Set(), explanation: null, latestTopic: null };
    existing.count += 1;
    if (topic) { existing.topics.add(topic); existing.latestTopic = topic; }
    if (picked.misconception.explanation) existing.explanation = picked.misconception.explanation;
    firings.set(tag, existing);
  }

  // #7: topics this attempt touched, regardless of correctness — used to
  // advance the review clock on tags that DIDN'T fire this time (the
  // "verified" half of verified re-checks). Only collected when the flag
  // is on so flag-off behavior stays byte-identical to pre-#7 code.
  const attemptTopics = new Set();
  if (reviewEnabled) {
    for (const answer of attempt.answers) {
      const q = quiz.questions[answer?.questionIndex];
      const topic = (q?.concept || quiz.topic || '').toString().toLowerCase();
      if (topic) attemptTopics.add(topic);
    }
  }

  if (firings.size === 0 && attemptTopics.size === 0) return;

  // Load (or create) the ledger document.
  let ledger = await LedgerModel.findOne({ userId });
  if (!ledger) {
    if (firings.size === 0) return; // nothing fired and no ledger to advance
    ledger = new LedgerModel({ userId, entries: [] });
  }
  const now = new Date();

  for (const [tag, info] of firings.entries()) {
    let entry = ledger.entries.find(e => e.tag === tag);
    if (!entry) {
      entry = {
        tag,
        count: 0,
        firstSeenAt: now,
        topicsAffected: [],
      };
      ledger.entries.push(entry);
    }
    entry.count += info.count;
    entry.lastSeenAt = now;
    if (info.explanation) entry.recentExplanation = info.explanation;
    if (info.latestTopic) entry.recentTopic = info.latestTopic;
    for (const t of info.topics) {
      if (!entry.topicsAffected.includes(t)) entry.topicsAffected.push(t);
    }
    if (reviewEnabled) {
      // Firing (re)opens the item and resets the review clock — a
      // recurrence means the previous "closed" verdict no longer holds.
      entry.reviewStage = 0;
      entry.nextReviewAt = new Date(now.getTime() + REVIEW_INTERVALS[0] * DAY_MS);
      entry.closedAt = null;
    }
  }

  const closedTags = [];
  let anyAdvanced = false;
  if (reviewEnabled && attemptTopics.size > 0) {
    for (const entry of ledger.entries) {
      if (firings.has(entry.tag)) continue; // just (re)scheduled above, don't also advance
      const touchesTopic = (entry.recentTopic && attemptTopics.has(entry.recentTopic)) ||
        (entry.topicsAffected || []).some(t => attemptTopics.has(t));
      if (!touchesTopic) continue;
      const result = advanceReview(entry, now);
      if (result.advanced) anyAdvanced = true;
      if (result.closed) closedTags.push(entry.tag);
    }
  }

  if (firings.size === 0 && !anyAdvanced) return; // nothing actually changed

  ledger.totalMisconceptionsTracked = (ledger.totalMisconceptionsTracked || 0) +
    Array.from(firings.values()).reduce((sum, f) => sum + f.count, 0);
  ledger.lastUpdatedAt = now;
  await ledger.save();

  if (reviewEnabled) {
    for (const tag of closedTags) {
      try {
        await record({
          agentId: 'misconception_tutor',
          decisionType: 'recommendation',
          userId,
          action: { kind: 'misconception_closed', tag, stagesPassed: REVIEW_INTERVALS.length },
          promptVersion: 'miscon-v1',
        });
      } catch (err) {
        console.warn('[misconceptionService] closure ledger record failed:', err.message);
      }
    }
  }
}

/**
 * Return the top recurring misconceptions for the Insights signal layer.
 * "Recurring" = >=3 instances AND covers >=2 distinct topics within the
 * last RECENCY_WINDOW_DAYS. Sorted by count desc.
 */
async function getRecurringPatterns(userId, limit = 3) {
  const ledger = await MisconceptionLedger.findOne({ userId }).lean();
  if (!ledger?.entries?.length) return [];
  const cutoff = Date.now() - T.RECENCY_WINDOW_DAYS * 86400000;

  return ledger.entries
    .filter(e => {
      if (!e.lastSeenAt) return false;
      if (new Date(e.lastSeenAt).getTime() < cutoff) return false;
      if ((e.count || 0) < T.RECURRING_MIN_COUNT) return false;
      if ((e.topicsAffected || []).length < T.RECURRING_MIN_TOPICS) return false;
      return true;
    })
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, limit)
    .map(e => ({
      tag: e.tag,
      count: e.count,
      topicsAffected: e.topicsAffected,
      explanation: e.recentExplanation,
      lastSeenAt: e.lastSeenAt,
    }));
}

/**
 * Open (unclosed) misconception re-checks that are due now, oldest first.
 * Powers the misconception_tutor agent's "is this still a problem?" nudge.
 *
 * @returns Promise<[{ tag, recentTopic, recentExplanation, reviewStage, nextReviewAt }]>
 */
async function getDueReviews(userId, limit = 2, deps = {}) {
  const { MisconceptionLedger: LedgerModel } = { ...defaultDeps(), ...deps };
  const now = new Date();
  const ledger = await LedgerModel.findOne({ userId }).lean();
  if (!ledger?.entries?.length) return [];

  return ledger.entries
    .filter(e => !e.closedAt && e.nextReviewAt && new Date(e.nextReviewAt) <= now)
    .sort((a, b) => new Date(a.nextReviewAt) - new Date(b.nextReviewAt))
    .slice(0, limit)
    .map(e => ({
      tag: e.tag,
      recentTopic: e.recentTopic,
      recentExplanation: e.recentExplanation,
      reviewStage: e.reviewStage,
      nextReviewAt: e.nextReviewAt,
    }));
}

module.exports = {
  recordFromAttempt,
  getRecurringPatterns,
  getDueReviews,
  advanceReview,
  REVIEW_INTERVALS,
  _T: T,
};
