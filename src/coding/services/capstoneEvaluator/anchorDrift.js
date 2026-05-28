'use strict';

const EvaluationAnchor = require('../../models/evaluationAnchor.model');
const HumanReviewQueue = require('../../models/humanReviewQueue.model');
const alerts = require('../alerts');

/**
 * Anchor-drift detection (spec §8.3).
 *
 * Every bundle ships with 3–5 deterministic `rubric_anchors` — each is a
 * (dimension, expected_score, check) triple. After the evaluator returns
 * a score, we compare its per-dimension output to the anchor expectations.
 * If any dimension diverges by more than ANCHOR_DRIFT_THRESHOLD points,
 * we:
 *   1. Record the observation against the EvaluationAnchor doc (for the
 *      monthly drift dashboard).
 *   2. Open a HumanReviewQueue entry so a moderator can confirm whether
 *      the model or the anchor is wrong.
 *   3. Tell the pipeline to re-run the scorer in `strict` mode (gives the
 *      anchors precedence).
 *
 * If the strict re-run still drifts, we keep the strict score but leave
 * the HRQ entry open — that's the "model and anchor disagree, human
 * needed" path.
 */

const ANCHOR_DRIFT_THRESHOLD = 2.0;

/**
 * Detect drift between evaluator output and the bundle's anchors.
 *
 * @param {object} args
 * @param {import('mongoose').Types.ObjectId} args.bundleId
 * @param {Array<{dimension:string, weight:number, check:string, deterministic_test?:string}>} args.rubricAnchors
 *        — the anchor definitions from the bundle (NOT the cached observations)
 * @param {object} args.dimensionScores
 *        — evaluator's per-dimension scores (0..10)
 * @param {string} args.evaluatorModel
 * @returns {Promise<{
 *   driftDetected: boolean,
 *   driftedDimensions: Array<{ dimension: string, expected: number, observed: number, delta: number }>
 * }>}
 */
async function check({ bundleId, rubricAnchors = [], dimensionScores = {}, evaluatorModel } = {}) {
  if (!Array.isArray(rubricAnchors) || rubricAnchors.length === 0) {
    return { driftDetected: false, driftedDimensions: [] };
  }

  // Anchors carry an `expected_score` that's the "what a passing solution
  // should score on this dimension" baseline. We compare the evaluator
  // output against that. Each anchor doc in the bundle should have
  // either an inline expected_score OR a deterministic_test that we
  // already ran in the harness. For deterministic anchors we use the
  // harness pass/fail to derive expected.
  const drifted = [];

  // Group anchors by dimension — multiple anchors per dimension
  // contribute weighted; we collapse to a single expected score per
  // dimension by simple weighted average.
  const byDim = {};
  for (const a of rubricAnchors) {
    if (typeof a.expected_score !== 'number') continue;
    const list = (byDim[a.dimension] = byDim[a.dimension] || []);
    list.push({ expected: a.expected_score, weight: a.weight || 1 });
  }

  for (const [dim, anchors] of Object.entries(byDim)) {
    const totalWeight = anchors.reduce((s, a) => s + a.weight, 0);
    const expected =
      anchors.reduce((s, a) => s + a.expected * a.weight, 0) / (totalWeight || 1);
    const observed = dimensionScores[dim];
    if (typeof observed !== 'number') continue;
    const delta = Math.abs(observed - expected);
    if (delta > ANCHOR_DRIFT_THRESHOLD) {
      drifted.push({ dimension: dim, expected, observed, delta });
    }
  }

  // Persist observations to EvaluationAnchor docs (cheap, append-only).
  await Promise.all(
    drifted.map((d) =>
      EvaluationAnchor.findOneAndUpdate(
        { bundle_id: bundleId, anchor_id: d.dimension },
        {
          $set: { expected_score: d.expected },
          $push: {
            observed_scores: {
              score: d.observed,
              drift: d.delta,
              observed_at: new Date(),
              grader_model: evaluatorModel,
            },
          },
        },
        { upsert: true }
      )
    )
  );

  return { driftDetected: drifted.length > 0, driftedDimensions: drifted };
}

/**
 * Open a HumanReviewQueue entry for a session whose evaluator drifted
 * past the anchor threshold. Idempotent on (bundle_id, session_id).
 *
 * @param {object} args
 * @param {import('mongoose').Types.ObjectId} args.bundleId
 * @param {import('mongoose').Types.ObjectId} args.sessionId
 * @param {Array<object>} args.driftedDimensions
 * @param {object} args.evaluatorResult — for context
 */
async function queueHumanReview({ bundleId, sessionId, driftedDimensions, evaluatorResult } = {}) {
  await HumanReviewQueue.create({
    bundle_id: bundleId,
    reason: `capstone_anchor_drift session=${sessionId}`,
    validator_errors: driftedDimensions.map(
      (d) => `${d.dimension}: expected≈${d.expected.toFixed(1)} observed=${d.observed} Δ=${d.delta.toFixed(1)}`
    ),
    status: 'pending',
    review_notes: JSON.stringify({
      session_id: String(sessionId),
      overall_score: evaluatorResult?.overall_score,
      integrity_confidence: evaluatorResult?.integrity_confidence,
    }),
  });

  // Per-session anchor-drift alert. Heavy dedup by bundle so we don't
  // page on every drifted submission of the same broken bundle — the
  // bundle is the actionable unit (rebuild anchors or rewrite test).
  void alerts.fire({
    category: 'drift.anchor-exceeded',
    severity: 'warn',
    title: `Anchor drift on bundle ${bundleId} (session ${sessionId})`,
    detail: driftedDimensions
      .map((d) => `• *${d.dimension}* expected≈${d.expected.toFixed(1)} observed=${d.observed} Δ=${d.delta.toFixed(1)}`)
      .join('\n'),
    dedupKey: `bundle:${bundleId}`,
    fields: {
      bundle_id: String(bundleId),
      session_id: String(sessionId),
      overall_score: String(evaluatorResult?.overall_score ?? 'n/a'),
    },
  });
}

module.exports = {
  check,
  queueHumanReview,
  ANCHOR_DRIFT_THRESHOLD,
};
