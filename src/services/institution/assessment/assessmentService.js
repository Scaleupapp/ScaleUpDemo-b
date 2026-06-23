'use strict';
function getModel(deps) { return (deps && deps.Assessment) || require('../../../models/Assessment'); }

async function createAssessment(scope, payload, deps) {
  const Assessment = getModel(deps);
  const { cohortId, departmentId, type, title, config, opensAt, closesAt, createdBy } = payload || {};
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

module.exports = { createAssessment, listAssessments, getAssessment, releaseAssessment };
