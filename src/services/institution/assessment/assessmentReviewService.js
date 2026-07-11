'use strict';
/**
 * Builds the detailed per-question review for an assessment session.
 *
 * Only MCQ engines have a per-question structure (the canonical Quiz the student
 * saw + their QuizAttempt answers). Other engines return null here and callers
 * fall back to the aggregated breakdown already in `session.result.raw`.
 *
 * Gating is the CALLER's responsibility — this service just shapes the data.
 * The student route gates on `isWindowClosed`; the TPO route never gates.
 */

/**
 * An assessment's detailed review is locked to students until the window closes.
 * Closed = the TPO manually closed it, OR a scheduled close time has passed.
 */
function isWindowClosed(assessment) {
  if (!assessment) return false;
  if (assessment.status === 'closed') return true;
  if (assessment.closesAt && new Date(assessment.closesAt) < new Date()) return true;
  return false;
}

/**
 * The contract (Wave 3 block 3) that tells apps/portal WHEN detailed review
 * unlocks for students:
 *   - 'at_closesAt' — a scheduled close time exists; review unlocks when it passes
 *     (or on an earlier manual close).
 *   - 'on_close'    — no scheduled close; review unlocks ONLY when the TPO manually
 *     closes the assessment. Without a manual close, review never unlocks — the
 *     create route surfaces a warning for the both-absent case.
 */
function reviewUnlockPolicy(assessment) {
  if (!assessment) return 'on_close';
  return assessment.closesAt ? 'at_closesAt' : 'on_close';
}

/**
 * Shape the per-question review for an MCQ session.
 * @returns {Promise<{ engineType: 'mcq', questions: Array }|null>} null for non-mcq or missing data.
 */
async function buildMcqReview(session, deps = {}) {
  if (!session || !session.engine || session.engine.type !== 'mcq') return null;
  const Quiz = deps.Quiz || require('../../../models/Quiz');
  const QuizAttempt = deps.QuizAttempt || require('../../../models/QuizAttempt');

  const [quiz, attempt] = await Promise.all([
    Quiz.findById(session.engine.quizId).lean(),
    QuizAttempt.findById(session.engine.sessionId).lean(),
  ]);
  if (!quiz || !Array.isArray(quiz.questions)) return null;

  // Map the student's answers by question index for an O(1) join.
  const answerByIndex = {};
  for (const a of (attempt && attempt.answers) || []) {
    answerByIndex[a.questionIndex] = a;
  }

  const questions = quiz.questions.map((q, i) => {
    const ans = answerByIndex[i] || {};
    return {
      index: i,
      questionText: q.questionText,
      scenario: q.scenario || null,
      options: (q.options || []).map((o) => ({ label: o.label, text: o.text })),
      correctAnswer: q.correctAnswer || null,
      explanation: q.explanation || null,
      studentAnswer: ans.selectedAnswer || null,
      isCorrect: typeof ans.isCorrect === 'boolean' ? ans.isCorrect : null,
    };
  });

  return { engineType: 'mcq', questions };
}

module.exports = { isWindowClosed, reviewUnlockPolicy, buildMcqReview };
