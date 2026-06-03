// src/services/employer/talentEligibilityService.js
'use strict';

// Career-intent objective types only — a NEET aspirant or hobby learner is noise to a recruiter.
// `upskilling` is included as job-focused per the design spec.
const CAREER_INTENT = new Set(['interview_preparation', 'career_switch', 'upskilling']);

// A candidate is poolable when their objective is career-intent AND they have real evidence
// (>=1 assessment/capstone/interview). Opt-in/active is enforced separately by the caller.
function isEligible({ objectiveType, evidenceCount }) {
  return CAREER_INTENT.has(objectiveType) && (evidenceCount || 0) > 0;
}

module.exports = { isEligible, CAREER_INTENT };
