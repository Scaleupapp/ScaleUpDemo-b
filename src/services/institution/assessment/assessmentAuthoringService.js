'use strict';
/**
 * Assessment Authoring Service
 *
 * Generates questions for MCQ assessments via quizGenerationService and
 * freezes them onto the Assessment document so the release gate can check
 * that questions exist before publishing to students.
 *
 * NOTE — generateQuiz KnowledgeProfile tolerance:
 *   quizGenerationService.generateQuiz calls KnowledgeProfile.findOne({ userId }).
 *   When the userId (assessment.createdBy, an InstitutionUser id) has no
 *   KnowledgeProfile, findOne returns null and the service gracefully falls back
 *   to level='beginner', targetDifficulty='medium' (lines 148-149 of
 *   quizGenerationService.js). The result is a standard beginner-mix quiz — no
 *   crash. Safe to call with any userId.
 *   Similarly, UserObjective.findOne returns null → competencyContext stays null
 *   (lines 189-234), userContextService failures are caught and swallowed
 *   (lines 327-347), and ExternalContentTouch failures are caught too
 *   (lines 353-371). The only hard failure path is the OpenAI call itself, which
 *   is expected to throw on network/API error — that bubble is intentional.
 */

function getModel(deps) { return (deps && deps.Assessment) || require('../../../models/Assessment'); }
function getQuiz(deps) { return (deps && deps.Quiz) || require('../../../models/Quiz'); }
function getQuizGenerationService(deps) {
  return (deps && deps.quizGenerationService) || require('../../quizGenerationService');
}

/**
 * Author (generate) MCQ questions for an assessment.
 *
 * @param {string|ObjectId} assessmentId
 * @param {object}          deps          - injectable: { Assessment, Quiz, quizGenerationService }
 * @returns {Promise<Assessment|null>}    - updated Assessment, or null if not mcq type
 */
async function authorMcq(assessmentId, deps = {}) {
  const Assessment = getModel(deps);
  const assessment = await Assessment.findById(assessmentId);
  if (!assessment) throw new Error('NOT_FOUND');

  // Only MCQ assessments need authored questions
  if (assessment.type !== 'mcq') return null;

  const cfg = assessment.config && assessment.config.mcq ? assessment.config.mcq : {};

  // Call quizGenerationService to produce questions via LLM.
  // suppressNotification + noObjective prevent D2C side-effects.
  const quizGenerationService = getQuizGenerationService(deps);
  const quiz = await quizGenerationService.generateQuiz({
    userId: assessment.createdBy,
    topic: cfg.topic || assessment.title,
    questionCount: cfg.totalQuestions || 10,
    assessmentType: cfg.assessmentType || 'mixed',
    isSkillAssessment: true,
    suppressNotification: true,
    noObjective: true,
  });

  // Freeze questions onto the assessment config so the release gate can check them.
  assessment.config.mcq.questions = quiz.questions;
  assessment.config.mcq.totalQuestions = quiz.questions.length;
  assessment.markModified('config');
  await assessment.save();

  // Best-effort: delete the throwaway quiz so it never appears in D2C history.
  const Quiz = getQuiz(deps);
  if (typeof Quiz.findByIdAndDelete === 'function') {
    try {
      await Quiz.findByIdAndDelete(quiz._id);
    } catch (e) {
      console.warn('[assessmentAuthoring] Could not delete throwaway quiz:', e.message);
    }
  }

  return assessment;
}

module.exports = { authorMcq };
