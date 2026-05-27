'use strict';

/**
 * Shared rubric helpers for drill graders.
 */

/**
 * Converts a rubric object into the array format stored on
 * DrillAttempt.grade.rubric_breakdown.
 *
 * Supports two input shapes:
 *   - New shape: { dimension: { score, feedback } }
 *   - Legacy/deterministic shape: { dimension: score }
 *
 * @param {Object.<string, number|{score: number, feedback: string}>} rubricObj
 * @returns {{ dimension: string, score: number, feedback: string }[]}
 */
function flattenRubric(rubricObj) {
  return Object.entries(rubricObj).map(([dimension, value]) => {
    // New shape: { score, feedback }
    if (value && typeof value === 'object' && 'score' in value) {
      return {
        dimension,
        score: value.score,
        feedback: value.feedback || '',
      };
    }
    // Backward compat — value is a plain number (deterministic dims)
    return { dimension, score: value, feedback: '' };
  });
}

module.exports = { flattenRubric };
