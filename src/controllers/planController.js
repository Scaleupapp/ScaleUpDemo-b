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
  return res.status(200).json({
    planId: String(plan._id),
    planHeadline: plan.planHeadline,
    estimatedTotalHours: plan.estimatedTotalHours,
    bufferRecommendation: plan.bufferRecommendation,
    weeklySchedule: plan.weeklySchedule,
    milestones: plan.milestones,
    source: plan.source,
    updatedAt: plan.updatedAt,
  });
}

module.exports = { getStatus, getCurrent };
