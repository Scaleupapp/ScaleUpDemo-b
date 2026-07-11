'use strict';

/**
 * Answer-side LLM-as-judge hook for drill graders (spec §Answer-side #3).
 *
 * Wraps gradeJudgeService.reconcile with the drill-specific evidence envelope.
 * Best-effort and fail-open: a judge error never bricks a drill grade. Coverage
 * is controlled by GRADE_JUDGE_SAMPLE_RATE (default 1.0).
 */

const gradeJudge = require('../../../services/grading/gradeJudgeService');

/**
 * @param {object} args
 * @param {number} args.overallScore — code-recomputed grader overall (0-100)
 * @param {object} args.rubric       — the grader's rubric dimensions
 * @param {*}      args.submission   — the learner's drill submission (evidence)
 * @param {() => Promise<{overall:number}>} [args.regrade] — one auto re-grade
 * @param {object} [deps]            — { gradeJudge, judgeDeps }
 * @returns {Promise<{overall_score:number, needs_review:boolean, judge_overall?:number, judge_disagreement?:number}>}
 */
async function judgeDrillGrade({ overallScore, rubric, submission, regrade }, deps = {}) {
  const svc = deps.gradeJudge || gradeJudge;
  const out = { overall_score: overallScore, needs_review: false };
  try {
    const v = await svc.reconcile(
      {
        engine: 'drill',
        evidence: submission,
        rubric,
        graderResult: { overall: overallScore, dimensions: rubric },
        regrade,
      },
      deps.judgeDeps || {}
    );
    if (v.sampled) {
      if (typeof v.finalOverall === 'number') out.overall_score = Math.round(v.finalOverall);
      out.needs_review = !!v.needsReview;
      out.judge_overall = v.judgeOverall;
      out.judge_disagreement = v.disagreement;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[drillGrader] answer-side judge failed:', err.message);
  }
  return out;
}

module.exports = { judgeDrillGrade };
