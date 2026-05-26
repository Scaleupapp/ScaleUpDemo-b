'use strict';

/**
 * Shared rubric helpers for drill graders.
 */

/**
 * Converts a flat rubric object { dimension: score, ... } into the
 * array format stored on DrillAttempt.grade.rubric_breakdown.
 *
 * @param {Object.<string, number>} rubricObj
 * @returns {{ dimension: string, score: number, feedback: string }[]}
 */
function flattenRubric(rubricObj) {
  return Object.entries(rubricObj).map(([dimension, score]) => ({
    dimension,
    score,
    feedback: '',
  }));
}

module.exports = { flattenRubric };
