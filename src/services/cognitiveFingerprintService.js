/**
 * Cognitive Fingerprint Service — BUG-8 Phase 6
 *
 * Computes time-of-day, modality, and session rhythm preferences for a
 * user from existing data. Stores the inferences in CognitiveProfile.
 *
 * Public API:
 *   compute(userId)              — recomputes the fingerprint (24h cache)
 *   get(userId)                  — returns cached fingerprint or null
 *   getHighConfidenceTraits(uid) — returns only the inferences confident
 *                                   enough to surface in UI
 */

const QuizAttempt = require('../models/QuizAttempt');
const ContentProgress = require('../models/ContentProgress');
const Content = require('../models/Content');
const CognitiveProfile = require('../models/CognitiveProfile');

const COMPUTE_INTERVAL_MS = 24 * 60 * 60 * 1000; // recompute at most once a day
const CONFIDENCE_THRESHOLD_TO_SURFACE = 0.6;

const T = {
  // Time-of-day
  TIME_MIN_ATTEMPTS: 10,                  // need this many quiz attempts before we trust the inference
  TIME_MIN_LIFT_PP: 8,                    // best-hour avg must beat overall avg by this many pp
  // Modality
  MODALITY_MIN_TOTAL: 6,                  // need this many content interactions overall
  MODALITY_MIN_PER_TYPE: 2,               // and at least this many per content-type to compare
  // Session rhythm
  RHYTHM_MIN_SESSIONS: 8,                 // minimum sessions to call a rhythm
};

// ──────────────────────────────────────────────────────────────
// Public
// ──────────────────────────────────────────────────────────────

async function compute(userId) {
  const existing = await CognitiveProfile.findOne({ userId });
  if (existing && (Date.now() - new Date(existing.computedAt).getTime()) < COMPUTE_INTERVAL_MS) {
    return existing.toObject();
  }

  const [attempts, progresses] = await Promise.all([
    QuizAttempt.find({ userId, completedAt: { $exists: true }, 'score.percentage': { $exists: true } })
      .sort({ completedAt: -1 })
      .limit(200)
      .select('completedAt score.percentage')
      .lean(),
    ContentProgress.find({ userId })
      .sort({ lastSessionAt: -1 })
      .limit(120)
      .lean(),
  ]);

  const timeOfDay = _computeTimeOfDay(attempts);
  const modality = await _computeModality(progresses);
  const sessionRhythm = _computeSessionRhythm(progresses);

  const updated = {
    userId, timeOfDay, modality, sessionRhythm, computedAt: new Date(),
  };

  await CognitiveProfile.findOneAndUpdate(
    { userId }, updated, { upsert: true, new: true }
  );
  return updated;
}

async function get(userId) {
  return CognitiveProfile.findOne({ userId }).lean();
}

async function getHighConfidenceTraits(userId) {
  const fp = await compute(userId);
  const traits = [];
  if (fp.timeOfDay?.confidence >= CONFIDENCE_THRESHOLD_TO_SURFACE && fp.timeOfDay.bestHourScoreLift >= T.TIME_MIN_LIFT_PP) {
    traits.push({ kind: 'time_of_day', ...fp.timeOfDay });
  }
  if (fp.modality?.confidence >= CONFIDENCE_THRESHOLD_TO_SURFACE && fp.modality.preferred) {
    traits.push({ kind: 'modality', ...fp.modality });
  }
  if (fp.sessionRhythm?.confidence >= CONFIDENCE_THRESHOLD_TO_SURFACE && fp.sessionRhythm.style) {
    traits.push({ kind: 'session_rhythm', ...fp.sessionRhythm });
  }
  return traits;
}

// ──────────────────────────────────────────────────────────────
// Internal computation helpers
// ──────────────────────────────────────────────────────────────

function _computeTimeOfDay(attempts) {
  if (!attempts || attempts.length < T.TIME_MIN_ATTEMPTS) {
    return { confidence: 0, sampleSize: attempts?.length || 0 };
  }

  // Bucket by hour-of-day
  const byHour = new Array(24).fill(null).map(() => ({ scores: [] }));
  for (const a of attempts) {
    const ts = new Date(a.completedAt);
    const pct = a.score?.percentage;
    if (!isFinite(pct)) continue;
    const hour = ts.getHours();
    byHour[hour].scores.push(pct);
  }

  const overallAvg = _avg(attempts.map(a => a.score?.percentage).filter(isFinite));

  // Find the hour with the highest avg AND at least 3 data points
  let bestHour = null;
  let bestAvg = -Infinity;
  for (let h = 0; h < 24; h++) {
    if (byHour[h].scores.length >= 3) {
      const avg = _avg(byHour[h].scores);
      if (avg > bestAvg) { bestAvg = avg; bestHour = h; }
    }
  }
  if (bestHour == null) {
    return { confidence: 0, sampleSize: attempts.length };
  }

  const lift = Math.round(bestAvg - overallAvg);
  // Confidence: scales with sample size and lift magnitude
  const sampleConfidence = Math.min(1, attempts.length / 30);
  const liftConfidence = Math.min(1, Math.abs(lift) / 20);
  const confidence = Math.round((sampleConfidence * 0.6 + liftConfidence * 0.4) * 100) / 100;

  return {
    bestHour,
    bestHourBlock: _hourBlock(bestHour),
    bestHourScoreLift: lift,
    confidence,
    sampleSize: attempts.length,
  };
}

async function _computeModality(progresses) {
  if (!progresses || progresses.length < T.MODALITY_MIN_TOTAL) {
    return { confidence: 0, sampleSize: progresses?.length || 0, completionRates: { video: 0, notes: 0, article: 0 } };
  }

  // Need to look up content types — batch in one query
  const ids = [...new Set(progresses.map(p => p.contentId).filter(Boolean).map(String))];
  const contents = await Content.find({ _id: { $in: ids } }).select('contentType').lean();
  const typeById = new Map(contents.map(c => [String(c._id), c.contentType]));

  const byType = { video: { total: 0, completed: 0 }, notes: { total: 0, completed: 0 }, article: { total: 0, completed: 0 } };
  for (const p of progresses) {
    const type = typeById.get(String(p.contentId));
    if (!byType[type]) continue;
    byType[type].total += 1;
    if (p.isCompleted) byType[type].completed += 1;
  }

  const rates = {
    video: byType.video.total ? byType.video.completed / byType.video.total : 0,
    notes: byType.notes.total ? byType.notes.completed / byType.notes.total : 0,
    article: byType.article.total ? byType.article.completed / byType.article.total : 0,
  };

  // Need at least MIN_PER_TYPE in two different types to make a comparison
  const eligibleTypes = Object.entries(byType).filter(([, v]) => v.total >= T.MODALITY_MIN_PER_TYPE);
  if (eligibleTypes.length < 2) {
    return { confidence: 0, sampleSize: progresses.length, completionRates: rates };
  }

  const sorted = eligibleTypes
    .map(([k]) => k)
    .sort((a, b) => rates[b] - rates[a]);
  const preferred = sorted[0];
  const secondPreferred = sorted[1] || null;
  const lead = rates[preferred] - (sorted[1] ? rates[sorted[1]] : 0);

  // Confidence: scale with total sample + the size of the preference lead
  const sampleConfidence = Math.min(1, progresses.length / 30);
  const leadConfidence = Math.min(1, lead * 3);
  const confidence = Math.round((sampleConfidence * 0.5 + leadConfidence * 0.5) * 100) / 100;

  return {
    preferred,
    secondPreferred,
    completionRates: rates,
    confidence,
    sampleSize: progresses.length,
  };
}

function _computeSessionRhythm(progresses) {
  if (!progresses || progresses.length < T.RHYTHM_MIN_SESSIONS) {
    return { confidence: 0, sampleSize: progresses?.length || 0 };
  }

  const minutes = progresses
    .map(p => (p.totalTimeSpent || 0) / 60)
    .filter(m => m > 0)
    .sort((a, b) => a - b);
  if (minutes.length < T.RHYTHM_MIN_SESSIONS) {
    return { confidence: 0, sampleSize: progresses.length };
  }

  const median = minutes[Math.floor(minutes.length / 2)];

  // Estimate sessions per day from spread of lastSessionAt
  const dates = progresses
    .map(p => p.lastSessionAt && new Date(p.lastSessionAt))
    .filter(Boolean)
    .sort((a, b) => a - b);
  let sessionsPerDay = 0;
  if (dates.length >= 2) {
    const spanDays = Math.max(1, (dates[dates.length - 1] - dates[0]) / 86400000);
    sessionsPerDay = Math.round((dates.length / spanDays) * 10) / 10;
  }

  let style = 'medium';
  if (median < 8) style = 'short_bursts';
  else if (median > 25) style = 'deep_focus';

  const sampleConfidence = Math.min(1, progresses.length / 25);
  const confidence = Math.round(sampleConfidence * 100) / 100;

  return {
    style,
    medianSessionMinutes: Math.round(median * 10) / 10,
    typicalSessionsPerDay: sessionsPerDay,
    confidence,
    sampleSize: progresses.length,
  };
}

// ──────────────────────────────────────────────────────────────
// Tiny helpers
// ──────────────────────────────────────────────────────────────

function _avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function _hourBlock(h) {
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

module.exports = {
  compute,
  get,
  getHighConfidenceTraits,
  _internal: { _computeTimeOfDay, _computeModality, _computeSessionRhythm, _hourBlock, T, CONFIDENCE_THRESHOLD_TO_SURFACE },
};
