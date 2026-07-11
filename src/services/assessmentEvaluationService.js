/**
 * Assessment Evaluation Service (Claude-powered)
 *
 * Evaluates quiz/assessment responses using Claude for:
 * - Text response grading (when user provides optional text answers)
 * - Competency-level scoring
 * - Enhanced analysis with specific feedback
 *
 * This service is called AFTER basic scoring (quizScoringService)
 * to add deeper evaluation on top.
 */

const aiProvider = require('../config/aiProvider');
const Quiz = require('../models/Quiz');
const QuizAttempt = require('../models/QuizAttempt');

const EVALUATION_SYSTEM_PROMPT = `You are an expert educational evaluator and competency assessor.

Evaluate the user's assessment responses and provide detailed feedback.

You will receive:
- The assessment questions with correct answers
- The user's selected MCQ answers
- Any optional text responses the user provided
- The user's objective context

Return VALID JSON with this structure:
{
  "textEvaluations": [
    {
      "questionIndex": 0,
      "score": 85,
      "feedback": "Your reasoning is sound but missed the importance of...",
      "partialCredit": true
    }
  ],
  "competencyBreakdown": [
    {
      "competency": "User Research",
      "correct": 3,
      "total": 4,
      "percentage": 75,
      "textScoreAvg": 80,
      "level": "competent",
      "feedback": "Strong foundation in user research methods..."
    }
  ],
  "overallFeedback": "string — 2-3 sentences of personalized feedback",
  "strengthsDetailed": ["specific strength with evidence"],
  "weaknessesDetailed": ["specific weakness with what to improve"],
  "recommendedFocus": ["what to study/practice next"]
}

RULES:
- Score text responses 0-100 based on accuracy, depth, and relevance
- Give partial credit for partially correct reasoning
- Be specific in feedback — reference the actual content of their answer
- Competency levels: 'awareness', 'foundational', 'competent', 'proficient', 'expert'
- Be encouraging but honest — don't inflate scores`;

class AssessmentEvaluationService {

  /**
   * Evaluate an assessment attempt with Claude
   * Called after basic scoring to enhance with text evaluation and competency breakdown
   *
   * @param {String} attemptId - QuizAttempt ID
   * @returns {Object} Updated attempt with enhanced evaluation
   */
  async evaluateAttempt(attemptId) {
    const attempt = await QuizAttempt.findById(attemptId);
    if (!attempt) throw new Error('Attempt not found');

    const quiz = await Quiz.findById(attempt.quizId);
    if (!quiz) throw new Error('Quiz not found');

    // Check if there are text responses or competency-tagged questions to evaluate
    const hasTextResponses = attempt.answers.some(a => a.textResponse);
    const hasCompetencies = quiz.questions.some(q => q.competency);

    if (!hasTextResponses && !hasCompetencies) {
      // Nothing extra to evaluate — basic scoring is sufficient
      return attempt;
    }

    // Build evaluation context
    const evaluationContext = {
      assessmentType: quiz.assessmentType || 'knowledge_recall',
      topic: quiz.topic,
      linkedCompetencies: quiz.linkedCompetencies || [],
      questions: quiz.questions.map((q, i) => ({
        index: i,
        questionText: q.questionText,
        scenario: q.scenario || null,
        questionType: q.questionType,
        options: q.options,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation,
        competency: q.competency || null,
        concept: q.concept || null,
      })),
      userAnswers: attempt.answers.map(a => ({
        questionIndex: a.questionIndex,
        selectedAnswer: a.selectedAnswer,
        isCorrect: a.isCorrect,
        textResponse: a.textResponse || null,
        timeTaken: a.timeTaken,
      })),
      mcqScore: attempt.score,
    };

    console.log(`[AssessmentEval] Evaluating attempt ${attemptId} with Claude`);
    console.log(`[AssessmentEval] ${hasTextResponses ? 'Has text responses' : 'MCQ only'}, ${hasCompetencies ? 'Has competencies' : 'No competency tags'}`);

    try {
      const evaluation = await aiProvider.evaluateWithClaude({
        systemPrompt: EVALUATION_SYSTEM_PROMPT,
        userPrompt: JSON.stringify(evaluationContext),
        temperature: 0.2,
        maxTokens: 4000,
        // Preserve prior behaviour: this path already null-guards each field of
        // the returned object, so keep the lenient {text} fallback rather than throw.
        lenient: true,
      });

      if (!evaluation || typeof evaluation === 'string') {
        console.error('[AssessmentEval] Claude returned non-JSON response');
        return attempt;
      }

      // Apply text evaluations to individual answers
      if (evaluation.textEvaluations && Array.isArray(evaluation.textEvaluations)) {
        for (const te of evaluation.textEvaluations) {
          const answerIdx = attempt.answers.findIndex(a => a.questionIndex === te.questionIndex);
          if (answerIdx >= 0) {
            attempt.answers[answerIdx].textEvaluation = {
              score: te.score,
              feedback: te.feedback,
              partialCredit: te.partialCredit || false,
            };
          }
        }
      }

      // Apply competency breakdown
      if (evaluation.competencyBreakdown && Array.isArray(evaluation.competencyBreakdown)) {
        attempt.competencyBreakdown = evaluation.competencyBreakdown.map(cb => ({
          competency: cb.competency,
          correct: cb.correct,
          total: cb.total,
          percentage: cb.percentage,
          textScoreAvg: cb.textScoreAvg || null,
          level: cb.level,
        }));
      }

      // Enhance analysis with Claude's detailed feedback
      if (evaluation.strengthsDetailed) {
        attempt.analysis = attempt.analysis || {};
        attempt.analysis.strengths = evaluation.strengthsDetailed;
      }
      if (evaluation.weaknessesDetailed) {
        attempt.analysis = attempt.analysis || {};
        attempt.analysis.weaknesses = evaluation.weaknessesDetailed;
      }

      await attempt.save();
      console.log(`[AssessmentEval] Enhanced evaluation saved for attempt ${attemptId}`);

      return attempt;
    } catch (err) {
      console.error('[AssessmentEval] Claude evaluation failed:', err.message);
      // Non-fatal — basic scoring still applies
      return attempt;
    }
  }
}

module.exports = new AssessmentEvaluationService();
