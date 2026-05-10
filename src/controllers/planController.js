const Plan = require('../models/Plan');
const DiagnosticAttempt = require('../models/DiagnosticAttempt');
const apiResponse = require('../utils/apiResponse');

async function getStatus(req, res) {
  const userId = req.user.userId;
  const activePlan = await Plan.findOne({ userId, isActive: true })
    .sort({ updatedAt: -1 })
    .lean();
  if (activePlan) {
    return res.status(200).json(apiResponse.success({
      status: 'ready',
      planId: String(activePlan._id),
      source: activePlan.source,
      updatedAt: activePlan.updatedAt,
    }));
  }
  const latestAttempt = await DiagnosticAttempt.findOne({ userId, status: 'completed' })
    .sort({ completedAt: -1 })
    .select('planGenerationStatus planId')
    .lean();
  if (!latestAttempt) {
    return res.status(200).json(apiResponse.success({ status: 'no_diagnostic', planId: null }));
  }
  return res.status(200).json(apiResponse.success({
    status: latestAttempt.planGenerationStatus || 'pending',
    planId: latestAttempt.planId ? String(latestAttempt.planId) : null,
  }));
}

async function getCurrent(req, res) {
  const userId = req.user.userId;
  const plan = await Plan.findOne({ userId, isActive: true })
    .sort({ updatedAt: -1 })
    .lean();
  if (!plan) return res.status(404).json(apiResponse.error('No active plan'));

  // Resolve canonical → display names via TopicTaxonomy (best-effort).
  const displayByCanonical = new Map();
  try {
    const TopicTaxonomy = require('../models/TopicTaxonomy');
    const UserObjective = require('../models/UserObjective');
    const obj = plan.objectiveId ? await UserObjective.findById(plan.objectiveId).lean() : null;
    if (obj) {
      const { buildTargetKey } = require('../services/diagnostic/topicTaxonomyService');
      const targetKey = buildTargetKey(obj.objectiveType, obj.specificsCanonical || obj.specifics || {});
      const tax = await TopicTaxonomy.findOne({ objectiveType: obj.objectiveType, targetKey }).lean();
      for (const t of (tax?.topics || [])) displayByCanonical.set(t.canonicalName, t.name);
    }
  } catch (_) { /* fall back to canonical names */ }

  const weeklySchedule = (plan.weeklySchedule || []).map(w => {
    const totalHours = (w.allocations || []).reduce((s, a) => s + (a.hours || 0), 0);
    return {
      weekNumber: w.week,
      weekLabel: w.weeklyGoal || `Week ${w.week}`,
      totalHours,
      allocations: (w.allocations || []).map(a => ({
        topic: displayByCanonical.get(a.topicCanonicalName) || a.topicCanonicalName,
        canonicalTopic: a.topicCanonicalName,
        hoursAllocated: a.hours,
        focusActivity: a.focusActivity,
      })),
      tasks: (w.tasks || []).map(t => ({
        taskId: String(t._id),
        type: t.type,
        topic: t.topic,
        payload: t.payload || {},
        completion: t.completion,
        progress: {
          status: t.progress?.status || 'pending',
          completedAt: t.progress?.completedAt || null,
          selfRating: t.progress?.selfRating || null,
        },
      })),
    };
  });

  const milestones = (plan.milestones || []).map(m => ({
    title: m.title,
    measurableCriteria: m.measurableCriteria,
    weekTarget: m.week,
    isUserStated: !!m.isUserStated,
  }));

  // Compute nextCheckInAt from the diagnostic attempt that produced this plan.
  // Falls back to plan.updatedAt if the attempt is missing (defensive only —
  // every plan should have a diagnosticAttemptId per the schema).
  let nextCheckInAt = null;
  try {
    const attempt = plan.diagnosticAttemptId
      ? await DiagnosticAttempt.findById(plan.diagnosticAttemptId).lean()
      : null;
    const anchor = attempt?.completedAt || plan.updatedAt;
    if (anchor) {
      nextCheckInAt = new Date(new Date(anchor).getTime() + 7 * 86400000).toISOString();
    }
  } catch (_) { /* leave null */ }

  return res.status(200).json(apiResponse.success({
    planId: String(plan._id),
    planHeadline: plan.planHeadline,
    totalWeeks: weeklySchedule.length,
    totalHours: plan.estimatedTotalHours || 0,
    milestoneCount: milestones.length,
    bufferRecommendation: plan.bufferRecommendation || null,
    weeklySchedule,
    milestones,
    source: plan.source,
    nextCheckInAt,
  }));
}

async function markTaskComplete(req, res) {
  const userId = req.user.userId;
  const { taskId } = req.params;
  const { selfRating } = req.body || {};

  const planProgressService = require('../services/plan/planProgressService');
  const result = await planProgressService.markManualComplete({ userId, taskId, selfRating });

  if (result.matched) {
    return res.status(200).json(apiResponse.success({
      taskId: result.taskId,
      planId: result.planId,
      weekNumber: result.weekNumber,
    }));
  }

  // Map service-level reasons to HTTP status codes.
  const statusByReason = {
    invalid_self_rating: 400,
    task_not_found: 404,
    no_active_plan: 404,
    concurrent_update: 409,
  };
  const status = statusByReason[result.reason] || 400;
  return res.status(status).json(apiResponse.error(result.reason || 'unknown_error'));
}

module.exports = { getStatus, getCurrent, markTaskComplete };
