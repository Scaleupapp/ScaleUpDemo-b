'use strict';

/**
 * Pure mapping from objective type to outcome-set archetype key.
 * Extracted here to break the targetService ↔ outcomeService circular dependency.
 * No upward imports (does not require targetService or outcomeService).
 */
function setKeyFor(objectiveType) {
  switch (objectiveType) {
    case 'interview_preparation':
    case 'career_switch': return 'interview';
    case 'exam_preparation': return 'exam';
    case 'upskilling':
    case 'academic_excellence': return 'skill';
    default: return 'generic';
  }
}

module.exports = { setKeyFor };
