/**
 * Spaced Repetition Service — BUG-8 Phase 5
 *
 * A pragmatic FSRS-style scheduler that decides when each (user, concept)
 * pair should be re-reviewed. Public surface:
 *
 *   recordFromAttempt(userId, attempt, quiz)
 *     Walks the per-question results and updates ConceptMastery for each
 *     concept the attempt touched. Quality grade is derived from
 *     correctness + speed.
 *
 *   getDueConcepts(userId, opts)
 *     Returns the ConceptMastery rows whose nextReviewAt has passed.
 *     Used by the Insights service to surface a "due for review" card.
 *
 * The math here is intentionally conservative — close enough to FSRS to
 * be useful, simple enough to debug. We can swap in the official ts-fsrs
 * package later without changing the call sites (the model state matches
 * its expected fields).
 */

const ConceptMastery = require('../models/ConceptMastery');

const DAY_MS = 86400000;

const T = {
  // Caps on FSRS state to prevent runaway values
  STABILITY_MIN: 0.5,
  STABILITY_MAX: 365,
  DIFFICULTY_MIN: 1.0,
  DIFFICULTY_MAX: 10.0,
  // Recency window used by getDueConcepts
  DUE_LOOKBACK_DAYS: 60,
};

/** Map a (correctness, speed) pair to an FSRS quality grade 0-3. */
function _quality({ isCorrect, timeTaken, expectedTime = 30 }) {
  if (!isCorrect) return 0; // lapse
  if (timeTaken == null) return 2; // unknown speed → "good"
  if (timeTaken <= expectedTime * 0.5) return 3; // easy
  if (timeTaken >= expectedTime * 1.8) return 1; // slow but correct → "hard"
  return 2; // good
}

/** Apply one FSRS-style update to mastery state. Returns updated state. */
function _updateState(state, quality) {
  const old = {
    stability: state.stability ?? 1.0,
    difficulty: state.difficulty ?? 5.0,
    reps: state.reps ?? 0,
    lapses: state.lapses ?? 0,
  };

  let { stability, difficulty, reps, lapses } = old;

  if (quality === 0) {
    // Lapse — reset reps, stability collapses, difficulty climbs
    lapses += 1;
    reps = 0;
    stability = Math.max(T.STABILITY_MIN, stability * 0.4);
    difficulty = Math.min(T.DIFFICULTY_MAX, difficulty + 0.8);
  } else {
    reps += 1;
    // Stability grows — multiplier depends on difficulty and quality
    const qFactor = quality === 1 ? 1.2 : quality === 2 ? 1.7 : 2.5;
    const dPenalty = 1 + (difficulty - 5) * 0.05; // harder concepts grow stability slower
    stability = Math.min(T.STABILITY_MAX, Math.max(T.STABILITY_MIN, stability * (qFactor / dPenalty)));
    // Difficulty drifts toward 5 (ease) on success, faster on "easy"
    const drift = quality === 3 ? -0.4 : quality === 2 ? -0.1 : 0.1;
    difficulty = Math.min(T.DIFFICULTY_MAX, Math.max(T.DIFFICULTY_MIN, difficulty + drift));
  }

  const intervalDays = stability;
  const nextReviewAt = new Date(Date.now() + intervalDays * DAY_MS);

  return {
    stability, difficulty, reps, lapses,
    lastQuality: quality,
    lastReviewedAt: new Date(),
    nextReviewAt,
  };
}

/**
 * Record a scored quiz attempt — bulks one DB call per concept touched.
 * Non-fatal: caller should wrap in try/catch.
 */
async function recordFromAttempt(userId, attempt, quiz) {
  if (!attempt?.answers?.length || !quiz?.questions?.length) return;

  // Group answers by concept so multiple questions on the same concept
  // collapse into a single FSRS update (averaged quality).
  const byConcept = new Map(); // concept -> { qualities: [], topic }
  for (const ans of attempt.answers) {
    if (ans.selectedAnswer === 'skipped') continue;
    const q = quiz.questions[ans.questionIndex];
    if (!q) continue;
    const concept = (q.concept || quiz.topic || '').toString().toLowerCase().trim();
    if (!concept) continue;
    const quality = _quality({
      isCorrect: !!ans.isCorrect,
      timeTaken: ans.timeTaken,
      expectedTime: q.timeLimit || quiz.timePerQuestion || 30,
    });
    if (!byConcept.has(concept)) byConcept.set(concept, { qualities: [], topic: quiz.topic });
    byConcept.get(concept).qualities.push(quality);
  }

  for (const [concept, info] of byConcept.entries()) {
    const avgQuality = Math.round(info.qualities.reduce((s, q) => s + q, 0) / info.qualities.length);
    let mastery = await ConceptMastery.findOne({ userId, concept });
    if (!mastery) {
      mastery = new ConceptMastery({ userId, concept, topic: info.topic });
    }
    const next = _updateState({
      stability: mastery.stability,
      difficulty: mastery.difficulty,
      reps: mastery.reps,
      lapses: mastery.lapses,
    }, avgQuality);
    Object.assign(mastery, next);
    if (info.topic && !mastery.topic) mastery.topic = info.topic;
    await mastery.save();
  }
}

/**
 * Find concepts whose nextReviewAt is in the past (overdue for review).
 * Sorted by how overdue they are, descending.
 *
 * @returns Array<{ concept, topic, daysOverdue, stability, lapses, lastReviewedAt }>
 */
async function getDueConcepts(userId, { limit = 5 } = {}) {
  const now = new Date();
  const lookbackCutoff = new Date(Date.now() - T.DUE_LOOKBACK_DAYS * DAY_MS);
  const due = await ConceptMastery.find({
    userId,
    nextReviewAt: { $lte: now, $gte: lookbackCutoff },
    reps: { $gte: 1 }, // skip concepts the user has never seen
  })
    .sort({ nextReviewAt: 1 })
    .limit(limit * 3) // grab extra so we can filter
    .lean();

  return due.map(m => ({
    concept: m.concept,
    topic: m.topic,
    daysOverdue: Math.max(0, (now.getTime() - new Date(m.nextReviewAt).getTime()) / DAY_MS),
    stability: m.stability,
    lapses: m.lapses,
    lastReviewedAt: m.lastReviewedAt,
  }))
  .sort((a, b) => b.daysOverdue - a.daysOverdue)
  .slice(0, limit);
}

module.exports = {
  recordFromAttempt,
  getDueConcepts,
  _internal: { _quality, _updateState, T },
};
