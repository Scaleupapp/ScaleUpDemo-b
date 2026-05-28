'use strict';

const EvaluationAnchor = require('../models/evaluationAnchor.model');
const HumanReviewQueue = require('../models/humanReviewQueue.model');
const CapstoneSession = require('../models/capstoneSession.model');
const LLMSpend = require('../models/llmSpend.model');

/**
 * Admin / ops read-only views for the capstone pipeline.
 *
 * - /api/coding/admin/anchor-drift  — recent drift observations + which
 *   bundles trip the threshold most often (spec §8.3 anti-drift).
 * - /api/coding/admin/human-review   — pending HRQ entries.
 * - /api/coding/admin/cost-summary   — per-task LLM spend rollup.
 * - /api/coding/admin/recent-sessions — capstone session activity.
 *
 * All endpoints require the caller to have role=admin (enforced by the
 * route's admin-auth middleware). They don't mutate state — they just
 * read.
 */

/** GET /api/coding/admin/anchor-drift */
async function anchorDrift(req, res) {
  const sinceDays = Number(req.query.since_days) || 30;
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  // Bundles whose anchors have drifted at least once in the window.
  const offenders = await EvaluationAnchor.aggregate([
    { $unwind: '$observed_scores' },
    { $match: { 'observed_scores.observed_at': { $gte: since } } },
    {
      $group: {
        _id: { bundle_id: '$bundle_id', anchor_id: '$anchor_id' },
        observations: { $sum: 1 },
        last_observed_at: { $max: '$observed_scores.observed_at' },
        mean_drift: { $avg: '$observed_scores.drift' },
        max_drift: { $max: '$observed_scores.drift' },
      },
    },
    { $sort: { max_drift: -1 } },
    { $limit: 100 },
  ]);

  // Overall drift rate for the period (% of sessions whose
  // anchor_drift_detected == true).
  const totalGraded = await CapstoneSession.countDocuments({
    status: 'graded',
    graded_at: { $gte: since },
  });
  const drifted = await CapstoneSession.countDocuments({
    status: 'graded',
    graded_at: { $gte: since },
    'result.anchor_drift_detected': true,
  });
  const driftRate = totalGraded > 0 ? drifted / totalGraded : 0;

  res.json({
    window_days: sinceDays,
    total_graded: totalGraded,
    drifted_sessions: drifted,
    drift_rate: round3(driftRate),
    target_rate: 0.05, // spec §14.2 quality gate
    target_met: driftRate < 0.05,
    by_bundle_anchor: offenders.map((o) => ({
      bundle_id: o._id.bundle_id,
      anchor_id: o._id.anchor_id,
      observations: o.observations,
      mean_drift: round3(o.mean_drift),
      max_drift: round3(o.max_drift),
      last_observed_at: o.last_observed_at,
    })),
  });
}

/** GET /api/coding/admin/human-review */
async function humanReview(req, res) {
  const status = req.query.status || 'pending';
  const items = await HumanReviewQueue.find({ status })
    .populate('bundle_id', 'type role_track difficulty drill_subtype brief')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  res.json({ items });
}

/** GET /api/coding/admin/cost-summary?days=30 */
async function costSummary(req, res) {
  const days = Number(req.query.days) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const byTask = await LLMSpend.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: { task_id: '$task_id', model: '$model' },
        calls: { $sum: 1 },
        tokens_in: { $sum: '$tokens_in' },
        tokens_out: { $sum: '$tokens_out' },
        cost_usd: { $sum: '$cost_usd' },
      },
    },
    { $sort: { cost_usd: -1 } },
  ]);

  const total = byTask.reduce((s, t) => s + t.cost_usd, 0);

  // Sessions over the per-session alert ceiling.
  const PER_SESSION_ALERT_USD = 1.0;
  const expensiveSessions = await LLMSpend.aggregate([
    { $match: { createdAt: { $gte: since }, session_id: { $ne: null } } },
    { $group: { _id: '$session_id', cost_usd: { $sum: '$cost_usd' } } },
    { $match: { cost_usd: { $gte: PER_SESSION_ALERT_USD } } },
    { $sort: { cost_usd: -1 } },
    { $limit: 50 },
  ]);

  res.json({
    window_days: days,
    total_cost_usd: round6(total),
    by_task: byTask.map((b) => ({
      task_id: b._id.task_id,
      model: b._id.model,
      calls: b.calls,
      tokens_in: b.tokens_in,
      tokens_out: b.tokens_out,
      cost_usd: round6(b.cost_usd),
    })),
    expensive_sessions: expensiveSessions.map((s) => ({
      session_id: String(s._id),
      cost_usd: round6(s.cost_usd),
    })),
    per_session_alert_threshold_usd: PER_SESSION_ALERT_USD,
  });
}

/** GET /api/coding/admin/recent-sessions */
async function recentSessions(req, res) {
  const days = Number(req.query.days) || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const stats = await CapstoneSession.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
  ]);

  const byStatus = {};
  for (const s of stats) byStatus[s._id] = s.count;

  res.json({ window_days: days, by_status: byStatus });
}

function round3(n) { return Math.round(n * 1000) / 1000; }
function round6(n) { return Math.round(n * 1_000_000) / 1_000_000; }

module.exports = {
  anchorDrift,
  humanReview,
  costSummary,
  recentSessions,
};
