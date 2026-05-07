const planGenerationService = require('../services/diagnostic/planGenerationService');
const planReadyNotificationService = require('../services/diagnostic/planReadyNotificationService');
const Plan = require('../models/Plan');
const DiagnosticAttempt = require('../models/DiagnosticAttempt');
const UserObjective = require('../models/UserObjective');
const CompanyProfile = require('../models/CompanyProfile');

const SELF_RATED_MIDPOINT = { novice: 15, familiar: 42, proficient: 67, expert: 90 };

function classifyCalibration(delta) {
  if (delta < -15) return 'overestimates';
  if (delta > 15) return 'undersells';
  return 'well-calibrated';
}

function buildContractInput(attempt, objective, companyProfile) {
  const resultsObj = attempt.results instanceof Map
    ? Object.fromEntries(attempt.results)
    : (attempt.results || {});
  const selfRatingsObj = attempt.selfRatings instanceof Map
    ? Object.fromEntries(attempt.selfRatings)
    : (attempt.selfRatings || {});
  const topicResults = Object.entries(resultsObj).map(([canonicalName, r]) => {
    const selfRating = selfRatingsObj[canonicalName] || 'familiar';
    const measuredScore = r.measuredScore ?? r.score ?? 0;
    const calibrationDelta = r.calibrationDelta ?? (measuredScore - SELF_RATED_MIDPOINT[selfRating] || 0);
    return {
      canonicalName,
      selfRating,
      measuredScore,
      measuredBand: r.band || r.assessedBand,
      calibrationDelta,
      calibrationClass: classifyCalibration(calibrationDelta),
      questionsAsked: r.questionsAsked || 0,
      answerPattern: r.answerPattern || {},
      isFutureProofing: !!r.isFutureProofing,
    };
  });

  return {
    userId: attempt.userId,
    objectiveId: objective._id,
    diagnosticAttemptId: attempt._id,
    objectiveType: objective.objectiveType,
    specificsCanonical: objective.specificsCanonical || objective.specifics || {},
    companyProfile,
    timeline: objective.timeline || 8,
    weeklyCommitHours: objective.weeklyCommitHours || 5,
    topicResults,
    userMilestoneHints: objective.userMilestoneHints || [],
  };
}

async function processJob(job) {
  const { attemptId } = job.data;
  if (!attemptId) throw new Error('planGenerationWorker: attemptId required');

  const attempt = await DiagnosticAttempt.findById(attemptId)
    .select('_id userId objectiveSnapshot results selfRatings planGenerationStatus planId')
    .lean();
  if (!attempt) {
    console.warn(`[planGenerationWorker] attempt ${attemptId} not found`);
    return { skipped: true };
  }

  const objectiveId = attempt.objectiveSnapshot?._id;
  if (!objectiveId) {
    await DiagnosticAttempt.updateOne({ _id: attemptId }, { $set: { planGenerationStatus: 'failed' } });
    return { skipped: true, reason: 'no_objective' };
  }

  const objective = await UserObjective.findById(objectiveId).lean();
  if (!objective) {
    await DiagnosticAttempt.updateOne({ _id: attemptId }, { $set: { planGenerationStatus: 'failed' } });
    return { skipped: true, reason: 'objective_missing' };
  }

  let companyProfile = null;
  const companyName = objective.specificsCanonical?.targetCompany || objective.specifics?.targetCompany;
  if (companyName) {
    companyProfile = await CompanyProfile.findOne({ normalizedName: String(companyName).toLowerCase().trim() }).lean();
  }

  try {
    const input = buildContractInput(attempt, objective, companyProfile);
    const generated = await planGenerationService.generate(input);

    await Plan.updateMany(
      { userId: attempt.userId, objectiveId, isActive: true },
      { $set: { isActive: false, supersededAt: new Date() } }
    );

    const plan = new Plan({
      userId: attempt.userId,
      objectiveId,
      diagnosticAttemptId: attempt._id,
      planHeadline: generated.planHeadline,
      estimatedTotalHours: generated.estimatedTotalHours,
      bufferRecommendation: generated.bufferRecommendation,
      weeklySchedule: generated.weeklySchedule,
      milestones: generated.milestones,
      source: generated.source,
      llmLatencyMs: generated.llmLatencyMs,
      llmModel: generated.llmModel,
      isActive: true,
    });
    await plan.save();

    await DiagnosticAttempt.updateOne(
      { _id: attemptId },
      { $set: { planGenerationStatus: 'ready', planId: plan._id } }
    );

    await planReadyNotificationService.notify(attempt.userId, plan._id);

    return { success: true, planId: plan._id };
  } catch (err) {
    console.error(`[planGenerationWorker] failed for attempt ${attemptId}:`, err.message);
    await DiagnosticAttempt.updateOne(
      { _id: attemptId },
      { $set: { planGenerationStatus: 'failed' } }
    );
    return { success: false, error: err.message };
  }
}

module.exports = { processJob, buildContractInput };
