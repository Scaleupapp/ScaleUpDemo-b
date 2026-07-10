'use strict';
function getModel(deps) { return (deps && deps.Assessment) || require('../../../models/Assessment'); }

async function createAssessment(scope, payload, deps) {
  const Assessment = getModel(deps);
  const InstitutionCohort = (deps && deps.InstitutionCohort) || require('../../../models/InstitutionCohort');
  const { cohortId, departmentId, type, title, config, opensAt, closesAt, createdBy } = payload || {};

  // E1: cohort belongs to institution
  const cohort = await InstitutionCohort.findOne({ _id: cohortId, ...scope });
  if (!cohort) throw new Error('COHORT_NOT_FOUND');

  // E2: per-type config validation
  if (type === 'interview') {
    if (!(config && config.interview && config.interview.interviewType)) {
      throw new Error('BAD_CONFIG');
    }
  }
  if (type === 'capstone') {
    const cap = config && config.capstone;
    if (!cap || (!cap.bundleId && !cap.roleTrack && !cap.jobDescription)) {
      throw new Error('BAD_CONFIG');
    }
    // Reject an explicitly-set roleTrack that is not in the model's allowed enum.
    // (No roleTrack is fine — authorCapstone defaults it to 'swe'.)
    const VALID_ROLE_TRACKS = ['swe', 'ds', 'ai_eng'];
    if (cap.roleTrack !== undefined && cap.roleTrack !== null &&
        !VALID_ROLE_TRACKS.includes(cap.roleTrack)) {
      throw new Error('BAD_CONFIG');
    }
  }
  if (type === 'drill') {
    const VALID_SUBTYPES = ['prompt', 'verify', 'decompose', 'refactor'];
    const VALID_ROLE_TRACKS = ['swe', 'ds', 'ai_eng'];
    const dr = config && config.drill;
    if (!dr || !VALID_SUBTYPES.includes(dr.drillSubtype)) {
      throw new Error('BAD_CONFIG');
    }
    if (dr.roleTrack !== undefined && dr.roleTrack !== null && !VALID_ROLE_TRACKS.includes(dr.roleTrack)) {
      throw new Error('BAD_CONFIG');
    }
  }

  // E3: window validation
  if (opensAt && closesAt && new Date(opensAt) >= new Date(closesAt)) {
    throw new Error('BAD_WINDOW');
  }

  return Assessment.create({
    ...scope, cohortId, departmentId, type, title, config,
    opensAt, closesAt, createdBy, status: 'configured',
  });
}

async function listAssessments(scope, { cohortId } = {}, deps) {
  const Assessment = getModel(deps);
  return Assessment.find({ ...scope, ...(cohortId ? { cohortId } : {}) }).sort({ createdAt: -1 }).limit(500);
}

async function getAssessment(scope, id, deps) {
  const Assessment = getModel(deps);
  return Assessment.findOne({ ...scope, _id: id });
}

// Maker-checker: release a configured assessment so students can take it in-window.
async function releaseAssessment(scope, id, releasedBy, deps) {
  const Assessment = getModel(deps);
  const a = await Assessment.findOne({ ...scope, _id: id });
  if (!a) throw new Error('NOT_FOUND');
  if (a.status !== 'configured') throw new Error('BAD_STATUS');
  // MCQ assessments must have questions authored before release
  if (a.type === 'mcq' && !(a.config && a.config.mcq && a.config.mcq.questions && a.config.mcq.questions.length)) {
    throw new Error('NO_QUESTIONS');
  }
  // Capstone assessments must have a bundle generated before release
  if (a.type === 'capstone' && !(a.config && a.config.capstone && a.config.capstone.bundleId)) {
    throw new Error('NO_BUNDLE');
  }
  if (a.type === 'drill' && !(a.config && a.config.drill && a.config.drill.bundleId)) {
    throw new Error('NO_BUNDLE');
  }
  a.status = 'released';
  a.releasedBy = releasedBy;
  a.releasedAt = new Date();
  await a.save();
  // Notify the cohort that a new assessment is open. Gated + best-effort:
  // never let a notification error fail the release.
  await _notifyAssessmentAssigned(a, deps);
  return a;
}

// Sub-feature C: close an assessment (I5)
async function closeAssessment(scope, id, by, deps) {
  const Assessment = getModel(deps);
  const a = await Assessment.findOne({ ...scope, _id: id });
  if (!a) throw new Error('NOT_FOUND');
  const now = (deps && deps.now && deps.now()) || new Date();
  a.status = 'closed';
  a.closedAt = now;
  if (!a.closesAt) a.closesAt = now;
  await a.save();
  // Manual close makes results available — same notify+guard as the sync worker.
  await _notifyAssessmentResults(a, deps);
  return a;
}

// ── Placement assessment notifications (Workstream B) ────────────────────────
// ALL emission is gated behind PLACEMENTS_NOTIFICATIONS_ENABLED (default OFF).
// With the flag off these are inert no-ops, so release/close behaviour — and
// every current D2C/placement app build — is completely unchanged.

function _closesClause(closesAt) {
  if (!closesAt) return '';
  const d = new Date(closesAt);
  if (isNaN(d.getTime())) return '';
  return ` — closes ${d.toDateString()}`;
}

async function _resolveCohortUserIds(cohortId, deps) {
  const InstitutionEnrollment = (deps && deps.InstitutionEnrollment) || require('../../../models/InstitutionEnrollment');
  const enrollments = await InstitutionEnrollment
    .find({ cohortId, userId: { $exists: true }, status: { $ne: 'withdrawn' } })
    .select('userId');
  return (enrollments || []).map((e) => e.userId).filter(Boolean);
}

// On release → tell the cohort a new assessment is open. Best-effort.
async function _notifyAssessmentAssigned(a, deps) {
  if (process.env.PLACEMENTS_NOTIFICATIONS_ENABLED !== 'true') return { notified: false, reason: 'disabled' };
  try {
    const notificationService = (deps && deps.notificationService) || require('../../notificationService');
    const userIds = await _resolveCohortUserIds(a.cohortId, deps);
    if (userIds.length === 0) return { notified: false, reason: 'no_recipients' };
    await notificationService.sendToUsers(userIds, {
      title: `New assessment: ${a.title}`,
      body: `${a.title} is now open${_closesClause(a.closesAt)}.`,
      data: { type: 'assessment_assigned', assessmentId: String(a._id) },
    });
    return { notified: true, count: userIds.length };
  } catch (err) {
    console.warn('[assessmentService] assessment_assigned notify failed (non-fatal):', err.message);
    return { notified: false, reason: 'error' };
  }
}

// On results-available → tell the cohort. Atomic notify-once guard: only the
// caller that flips resultsNotifiedAt (null → now) wins and notifies; concurrent
// worker ticks / sessions / a later manual close all no-op. Best-effort.
async function _notifyAssessmentResults(assessment, deps) {
  if (process.env.PLACEMENTS_NOTIFICATIONS_ENABLED !== 'true') return { notified: false, reason: 'disabled' };
  const Assessment = getModel(deps);
  const now = (deps && deps.now && deps.now()) || new Date();

  let won = null;
  try {
    won = await Assessment.findOneAndUpdate(
      { _id: assessment._id, $or: [{ resultsNotifiedAt: null }, { resultsNotifiedAt: { $exists: false } }] },
      { $set: { resultsNotifiedAt: now } },
      { new: true }
    );
  } catch (err) {
    console.warn('[assessmentService] results notify guard failed (non-fatal):', err.message);
    return { notified: false, reason: 'error' };
  }
  if (!won) return { notified: false, reason: 'already_notified' };

  try {
    const notificationService = (deps && deps.notificationService) || require('../../notificationService');
    const userIds = await _resolveCohortUserIds(assessment.cohortId, deps);
    if (userIds.length === 0) return { notified: false, reason: 'no_recipients' };
    await notificationService.sendToUsers(userIds, {
      title: 'Results are out',
      body: `Your ${assessment.title} results are ready to review.`,
      data: { type: 'assessment_results', assessmentId: String(assessment._id) },
    });
    return { notified: true, count: userIds.length };
  } catch (err) {
    console.warn('[assessmentService] assessment_results notify failed (non-fatal):', err.message);
    return { notified: false, reason: 'error' };
  }
}

module.exports = {
  createAssessment, listAssessments, getAssessment, releaseAssessment, closeAssessment,
  _notifyAssessmentAssigned, _notifyAssessmentResults,
};
