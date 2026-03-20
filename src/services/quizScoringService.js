const QuizAttempt = require('../models/QuizAttempt');
const Quiz = require('../models/Quiz');
const UserObjective = require('../models/UserObjective');
const { quizAnalysisQueue } = require('../config/queue');
const { updateStreak } = require('./streakService');

class QuizScoringService {

  async scoreQuiz(attemptId) {
    const attempt = await QuizAttempt.findById(attemptId);
    const quiz = await Quiz.findById(attempt.quizId);

    let correct = 0, incorrect = 0, skipped = 0;
    const topicScores = {};
    let totalTimeTaken = 0;
    let fastWrong = 0;

    for (const answer of attempt.answers) {
      const question = quiz.questions[answer.questionIndex];
      if (!question) continue;

      const isCorrect = answer.selectedAnswer === question.correctAnswer;
      answer.isCorrect = isCorrect;

      if (answer.selectedAnswer === 'skipped') { skipped++; }
      else if (isCorrect) { correct++; }
      else { incorrect++; }

      if (answer.timeTaken) totalTimeTaken += answer.timeTaken;
      if (!isCorrect && answer.timeTaken && answer.timeTaken < 10) fastWrong++;

      const concept = question.concept || quiz.topic;
      if (!topicScores[concept]) topicScores[concept] = { correct: 0, total: 0 };
      topicScores[concept].total++;
      if (isCorrect) topicScores[concept].correct++;
    }

    attempt.score = {
      total: quiz.totalQuestions,
      correct, incorrect, skipped,
      percentage: Math.round((correct / quiz.totalQuestions) * 100),
    };

    attempt.topicBreakdown = Object.entries(topicScores).map(([topic, data]) => ({
      topic, correct: data.correct, total: data.total,
      percentage: Math.round((data.correct / data.total) * 100),
    }));

    const avgTime = attempt.answers.length > 0 ? totalTimeTaken / attempt.answers.length : 0;
    const confidenceScore = fastWrong > attempt.answers.length * 0.3 ? 30 :
                            avgTime > 30 ? 80 : 60;

    // Find previous attempt for comparison
    const previousAttempt = await QuizAttempt.findOne({
      userId: attempt.userId, status: 'completed',
      _id: { $ne: attempt._id },
    }).sort({ completedAt: -1 });

    attempt.analysis = {
      strengths: attempt.topicBreakdown.filter(t => t.percentage >= 80).map(t => t.topic),
      weaknesses: attempt.topicBreakdown.filter(t => t.percentage < 50).map(t => t.topic),
      missedConcepts: attempt.answers
        .filter(a => !a.isCorrect && a.selectedAnswer !== 'skipped')
        .map(a => {
          const q = quiz.questions[a.questionIndex];
          return {
            concept: q?.concept, contentId: q?.sourceContentId,
            timestamp: q?.sourceTimestamp,
            suggestion: `Review the section on "${q?.concept}"`,
          };
        }),
      confidenceScore,
      comparisonToPrevious: previousAttempt ? {
        previousScore: previousAttempt.score?.percentage || 0,
        improvement: attempt.score.percentage - (previousAttempt.score?.percentage || 0),
        trend: attempt.score.percentage > (previousAttempt.score?.percentage || 0) + 5 ? 'improving' :
               attempt.score.percentage < (previousAttempt.score?.percentage || 0) - 5 ? 'declining' : 'stable',
      } : null,
    };

    attempt.status = 'completed';
    attempt.completedAt = new Date();
    attempt.totalTime = totalTimeTaken;
    await attempt.save();

    // Score feedback: update competency scores on objective after competency_assessment
    if (quiz.type === 'competency_assessment' && quiz.objectiveId && quiz.linkedCompetencies?.length > 0) {
      try {
        const objective = await UserObjective.findById(quiz.objectiveId);
        if (objective?.analysis?.competencies) {
          const quizScore = attempt.score.percentage;
          let updated = false;

          for (const compName of quiz.linkedCompetencies) {
            const comp = objective.analysis.competencies.find(c => c.name === compName);
            if (comp) {
              // Weighted average: 40% existing + 60% new assessment score
              const existing = comp.currentScore || 0;
              comp.currentScore = Math.round(existing * 0.4 + quizScore * 0.6);
              updated = true;
            }
          }

          // Also try matching by topic name for broader coverage
          const topicComp = objective.analysis.competencies.find(
            c => c.name.toLowerCase() === quiz.topic?.toLowerCase()
          );
          if (topicComp && !quiz.linkedCompetencies.includes(topicComp.name)) {
            const existing = topicComp.currentScore || 0;
            topicComp.currentScore = Math.round(existing * 0.4 + quizScore * 0.6);
            updated = true;
          }

          if (updated) {
            objective.markModified('analysis');
            await objective.save();
            console.log(`[QuizScoring] Updated competency scores on objective ${quiz.objectiveId} from assessment "${quiz.topic}"`);
          }
        }
      } catch (err) {
        console.error('[QuizScoring] Competency score feedback failed (non-fatal):', err.message);
      }
    }

    await quizAnalysisQueue.add('analyze', { attemptId: attempt._id, userId: attempt.userId });

    // Update streak — quiz completion counts as daily activity
    try { await updateStreak(attempt.userId.toString()); } catch { /* non-fatal */ }

    return attempt;
  }
}

module.exports = new QuizScoringService();
