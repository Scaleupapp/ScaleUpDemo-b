const Plan = require('../models/Plan');
const DiagnosticAttempt = require('../models/DiagnosticAttempt');

async function getStatus(req, res) {
  const userId = req.user.userId;
  const activePlan = await Plan.findOne({ userId, isActive: true })
    .sort({ updatedAt: -1 })
    .lean();
  if (activePlan) {
    return res.status(200).json({
      status: 'ready',
      planId: String(activePlan._id),
      source: activePlan.source,
      updatedAt: activePlan.updatedAt,
    });
  }
  const latestAttempt = await DiagnosticAttempt.findOne({ userId, status: 'completed' })
    .sort({ completedAt: -1 })
    .select('planGenerationStatus planId')
    .lean();
  if (!latestAttempt) {
    return res.status(200).json({ status: 'pending' });
  }
  return res.status(200).json({
    status: latestAttempt.planGenerationStatus || 'pending',
    planId: latestAttempt.planId ? String(latestAttempt.planId) : null,
  });
}

async function getCurrent(req, res) {
  const userId = req.user.userId;
  const plan = await Plan.findOne({ userId, isActive: true })
    .sort({ updatedAt: -1 })
    .lean();
  if (!plan) return res.status(404).json({ message: 'No active plan' });

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
    };
  });

  const milestones = (plan.milestones || []).map(m => ({
    title: m.title,
    measurableCriteria: m.measurableCriteria,
    weekTarget: m.week,
    isUserStated: !!m.isUserStated,
  }));

  return res.status(200).json({
    planId: String(plan._id),
    planHeadline: plan.planHeadline,
    totalWeeks: weeklySchedule.length,
    totalHours: plan.estimatedTotalHours || 0,
    milestoneCount: milestones.length,
    bufferRecommendation: plan.bufferRecommendation || null,
    weeklySchedule,
    milestones,
    source: plan.source,
  });
}

module.exports = { getStatus, getCurrent };
