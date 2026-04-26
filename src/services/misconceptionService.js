/**
 * Misconception Service — BUG-8 Phase 4
 *
 * Records every distractor-tagged misconception the user picks. A
 * "misconception" is a labelled wrong answer (e.g. "treats_correlation_as_causation")
 * that captures the false belief behind a wrong pick — far more useful
 * than just "they got it wrong".
 *
 * Public API:
 *   recordFromAttempt(userId, attempt, quiz)  — invoked once when a quiz is scored
 *   getRecurringPatterns(userId)              — used by the Insights service
 */

const MisconceptionLedger = require('../models/MisconceptionLedger');

const T = {
  RECURRING_MIN_COUNT: 3,        // need this many instances to call it "recurring"
  RECURRING_MIN_TOPICS: 2,       // and at least this many distinct topics for transfer-signal
  RECENCY_WINDOW_DAYS: 60,       // only consider entries with lastSeenAt within this window
};

/**
 * After a quiz is scored, walk through wrong answers and bump the
 * ledger for any whose option carries a misconception tag.
 * Idempotent on re-scoring: we deliberately don't track "which attempts
 * already counted" because the cost of double-counting is small (one
 * extra count) and the cost of forgetting (silent drift) is bigger.
 */
async function recordFromAttempt(userId, attempt, quiz) {
  if (!attempt?.answers?.length || !quiz?.questions?.length) return;

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

  if (firings.size === 0) return;

  // Load (or create) the ledger document.
  let ledger = await MisconceptionLedger.findOne({ userId });
  if (!ledger) {
    ledger = new MisconceptionLedger({ userId, entries: [] });
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
  }

  ledger.totalMisconceptionsTracked = (ledger.totalMisconceptionsTracked || 0) +
    Array.from(firings.values()).reduce((sum, f) => sum + f.count, 0);
  ledger.lastUpdatedAt = now;
  await ledger.save();
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

module.exports = {
  recordFromAttempt,
  getRecurringPatterns,
  _T: T,
};
