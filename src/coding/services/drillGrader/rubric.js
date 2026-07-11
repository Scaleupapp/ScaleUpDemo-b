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

/**
 * Extract a numeric 0-10 score from a rubric value that may be either the new
 * `{ score, feedback }` shape or a legacy plain number.
 *
 * @param {number|{score:number}} v
 * @returns {number} 0 when unparseable
 */
function scoreOf(v) {
  if (v && typeof v === 'object' && 'score' in v) return Number(v.score) || 0;
  return Number(v) || 0;
}

/**
 * Code-side overall recompute for LLM-scored drills (prompt, decompose).
 * Overall (0-100) = equal-weighted mean of the named dimensions × 10. The
 * LLM's self-reported overall_score is NOT trusted (spec §Answer-side
 * deterministic core: "ALL weighted overall scores recomputed in code").
 *
 * @param {Object.<string, number|{score:number}>} rubricObj
 * @param {string[]} dimensions
 * @returns {number} integer 0-100
 */
function recomputeEqualWeighted(rubricObj, dimensions) {
  const dims = Array.isArray(dimensions) ? dimensions : Object.keys(rubricObj || {});
  if (dims.length === 0) return 0;
  const sum = dims.reduce((s, d) => s + scoreOf((rubricObj || {})[d]), 0);
  return Math.round((sum / dims.length) * 10);
}

module.exports = { flattenRubric, scoreOf, recomputeEqualWeighted };
