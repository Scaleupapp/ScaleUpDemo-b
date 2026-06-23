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
  a.status = 'released';
  a.releasedBy = releasedBy;
  a.releasedAt = new Date();
  await a.save();
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
  return a;
}

module.exports = { createAssessment, listAssessments, getAssessment, releaseAssessment, closeAssessment };
