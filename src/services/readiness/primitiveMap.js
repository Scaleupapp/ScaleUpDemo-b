'use strict';

/**
 * Route a competency to the primitive that best MEASURES it, from the
 * competency's assessmentTypes (already produced by objectiveAnalysisService).
 * Priority when mixed: interview > coding > quiz (higher-signal wins).
 *
 * @param {string[]} assessmentTypes
 * @param {{coding:boolean}} ctx  — coding=true if the objective is coding-eligible
 * @returns {'quiz'|'coding'|'interview'}
 */
function assessmentTypesToPrimitive(assessmentTypes, ctx = { coding: false }) {
  const types = Array.isArray(assessmentTypes) ? assessmentTypes : [];
  const wantsInterview = types.some((t) => t === 'situational_judgment' || t === 'case_study');
  const wantsApplied = types.some((t) => t === 'applied_scenario' || t === 'framework_application');
  if (wantsInterview) return 'interview';
  if (wantsApplied) return ctx.coding ? 'coding' : 'interview';
  // knowledge_recall / exam_style / unknown / empty -> quiz
  return 'quiz';
}

module.exports = { assessmentTypesToPrimitive };
