/**
 * Re-calibration Results Service
 *
 * Computes growth bars comparing a recalibration attempt's measured scores
 * against the prior (initial) attempt. Identifies the biggest jump and any
 * new gaps (topics where score dropped >=20 pts relative to the baseline).
 *
 * persistGrowth saves the computed data to attempt.recalibrationGrowth.
 * rebalancePlan enqueues a new plan generation job for the attempt.
 */

const DiagnosticAttempt = require('../../models/DiagnosticAttempt');
const { planGenerationQueue } = require('../../config/queue');

const NEW_GAP_DROP_THRESHOLD = 20;

const BANDS = ['novice', 'familiar', 'proficient', 'expert'];

function scoreToBand(score) {
  if (score >= 85) return 'expert';
  if (score >= 65) return 'proficient';
  if (score >= 40) return 'familiar';
  return 'novice';
}

function bandShiftLabel(oldBand, newBand) {
  const oldIdx = BANDS.indexOf(oldBand);
  const newIdx = BANDS.indexOf(newBand);
  if (newIdx > oldIdx) return 'improved';
  if (newIdx < oldIdx) return 'regressed';
  return 'stable';
}

/**
 * Compute growth bars by diffing recalibration results against the previous attempt.
 *
 * @param {Object} recalAttempt - Mongoose lean doc for the recalibration attempt
 * @param {Object} prevAttempt  - Mongoose lean doc for the previous (baseline) attempt
 * @returns {Object} { growthBars, biggestJump, newGaps, summary }
 */
function computeGrowth(recalAttempt, prevAttempt) {
  const prevResults = prevAttempt?.results instanceof Map
    ? prevAttempt.results
    : new Map(Object.entries(prevAttempt?.results || {}));

  const recalResults = recalAttempt.results instanceof Map
    ? recalAttempt.results
    : new Map(Object.entries(recalAttempt.results || {}));

  const growthBars = [];
  const newGaps = [];

  for (const [canonicalName, r] of recalResults.entries()) {
    const newScore = r.score || 0;
    const prev = prevResults.get(canonicalName);
    const oldScore = prev?.score || 0;
    const delta = newScore - oldScore;

    const oldBand = scoreToBand(oldScore);
    const newBand = scoreToBand(newScore);
    const bandShift = bandShiftLabel(oldBand, newBand);

    growthBars.push({ canonicalName, oldScore, newScore, delta, oldBand, newBand, bandShift });

    if (delta <= -NEW_GAP_DROP_THRESHOLD) {
      newGaps.push(canonicalName);
    }
  }

  // Sort descending by delta for biggest-jump detection
  const sorted = [...growthBars].sort((a, b) => b.delta - a.delta);
  const biggestJump = sorted.length > 0
    ? { canonicalName: sorted[0].canonicalName, delta: sorted[0].delta, bandShift: sorted[0].bandShift }
    : null;

  const improved = growthBars.filter(b => b.delta > 0).length;
  const summary = improved > 0
    ? `You improved in ${improved} topic${improved === 1 ? '' : 's'}${newGaps.length > 0 ? ` and have ${newGaps.length} new gap${newGaps.length === 1 ? '' : 's'} to address` : ''}.`
    : newGaps.length > 0
    ? `You have ${newGaps.length} new gap${newGaps.length === 1 ? '' : 's'} to address.`
    : 'Your scores are stable across re-assessed topics.';

  return { growthBars, biggestJump, newGaps, summary };
}

/**
 * Compute and persist recalibrationGrowth on the attempt document.
 *
 * @param {String|ObjectId} recalAttemptId
 */
async function persistGrowth(recalAttemptId) {
  const recalAttempt = await DiagnosticAttempt.findById(recalAttemptId).lean();
  if (!recalAttempt) throw new Error(`Attempt ${recalAttemptId} not found`);

  let prevAttempt = null;
  if (recalAttempt.previousAttemptId) {
    prevAttempt = await DiagnosticAttempt.findById(recalAttempt.previousAttemptId).lean();
  }

  const growth = computeGrowth(recalAttempt, prevAttempt);

  await DiagnosticAttempt.updateOne(
    { _id: recalAttemptId },
    { $set: { recalibrationGrowth: growth } },
  );

  return growth;
}

/**
 * Enqueue a plan re-generation job for a recalibration attempt.
 * The existing planGenerationWorker handles superseding the prior plan.
 *
 * @param {String|ObjectId} recalAttemptId
 */
async function rebalancePlan(recalAttemptId) {
  await planGenerationQueue.add(
    'generate',
    { attemptId: String(recalAttemptId) },
    { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 50 },
  );
}

module.exports = { computeGrowth, persistGrowth, rebalancePlan, NEW_GAP_DROP_THRESHOLD };
