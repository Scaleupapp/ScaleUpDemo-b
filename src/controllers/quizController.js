const Quiz = require('../models/Quiz');
const QuizAttempt = require('../models/QuizAttempt');
const QuizTrigger = require('../models/QuizTrigger');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const Content = require('../models/Content');
const ContentProgress = require('../models/ContentProgress');
const Journey = require('../models/Journey');
const UserObjective = require('../models/UserObjective');
const quizTriggerService = require('../services/quizTriggerService');
const quizScoringService = require('../services/quizScoringService');
const assessmentEvaluationService = require('../services/assessmentEvaluationService');
const recommendationService = require('../services/recommendationService');
const journeyProgressService = require('../services/journeyProgressService');
const apiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

const listQuizzes = async (req, res, next) => {
  try {
    const quizzes = await Quiz.find({
      userId: req.user.userId,
      status: { $in: ['ready', 'delivered', 'in_progress', 'completed'] },
    }).sort({ createdAt: -1 }).select('-questions.correctAnswer -questions.explanation');
    res.json(apiResponse.success(quizzes));
  } catch (err) { next(err); }
};

const getHistory = async (req, res, next) => {
  try {
    const attempts = await QuizAttempt.find({ userId: req.user.userId, status: 'completed' })
      .sort({ completedAt: -1 })
      .populate('quizId', 'title topic type objectiveId');
    res.json(apiResponse.success(attempts));
  } catch (err) { next(err); }
};

const requestOnDemand = async (req, res, next) => {
  try {
    const { topic, contentIds, questionCount, assessmentType, objectiveId, isSkillAssessment, noObjective } = req.body;
    const trigger = await quizTriggerService.triggerOnDemand(req.user.userId, { topic, contentIds, questionCount, assessmentType, objectiveId, isSkillAssessment, noObjective });
    res.json(apiResponse.success({
      triggerId: trigger._id,
      status: trigger.status,
      topic: trigger.topic,
    }, 'Quiz generation started. You will be notified when ready.'));
  } catch (err) { next(err); }
};

const getQuiz = async (req, res, next) => {
  try {
    const quiz = await Quiz.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!quiz) throw new ApiError(404, 'Quiz not found');

    const attempt = await QuizAttempt.findOne({ userId: req.user.userId, quizId: quiz._id });
    const quizObj = quiz.toObject();

    // Hide answers if not yet completed
    if (!attempt || attempt.status !== 'completed') {
      quizObj.questions = quizObj.questions.map(q => {
        const { correctAnswer, explanation, ...rest } = q;
        return rest;
      });
    }

    if (quiz.status === 'ready') {
      quiz.status = 'delivered';
      quiz.deliveredAt = new Date();
      await quiz.save();
    }

    res.json(apiResponse.success(quizObj));
  } catch (err) { next(err); }
};

const startAttempt = async (req, res, next) => {
  try {
    const quiz = await Quiz.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!quiz) throw new ApiError(404, 'Quiz not found');

    const existing = await QuizAttempt.findOne({
      userId: req.user.userId, quizId: quiz._id, status: 'in_progress',
    });
    if (existing) return res.json(apiResponse.success(existing, 'Attempt already in progress'));

    const attempt = await QuizAttempt.create({
      userId: req.user.userId, quizId: quiz._id,
      answers: [], startedAt: new Date(), status: 'in_progress',
    });

    quiz.status = 'in_progress';
    await quiz.save();

    res.status(201).json(apiResponse.success(attempt));
  } catch (err) { next(err); }
};

const submitAnswer = async (req, res, next) => {
  try {
    const { questionIndex, selectedAnswer, timeTaken, textResponse } = req.body;

    const attempt = await QuizAttempt.findOne({
      quizId: req.params.id, userId: req.user.userId, status: 'in_progress',
    });
    if (!attempt) throw new ApiError(404, 'No active attempt found');

    // Look up the question to capture competency tag
    const quiz = await Quiz.findById(req.params.id);
    const question = quiz?.questions?.[questionIndex];

    const existingIdx = attempt.answers.findIndex(a => a.questionIndex === questionIndex);
    const answerData = {
      questionIndex,
      selectedAnswer,
      timeTaken,
      textResponse: textResponse || undefined,
      competency: question?.competency || undefined,
    };

    if (existingIdx >= 0) {
      attempt.answers[existingIdx] = answerData;
    } else {
      attempt.answers.push(answerData);
    }
    await attempt.save();

    res.json(apiResponse.success(attempt));
  } catch (err) { next(err); }
};

const completeQuiz = async (req, res, next) => {
  try {
    const attempt = await QuizAttempt.findOne({
      quizId: req.params.id, userId: req.user.userId, status: 'in_progress',
    });
    if (!attempt) throw new ApiError(404, 'No active attempt found');

    const scored = await quizScoringService.scoreQuiz(attempt._id);

    // Run Claude-powered enhanced evaluation (text responses + competency breakdown)
    // Non-blocking — if it fails, basic scoring still applies
    try {
      await assessmentEvaluationService.evaluateAttempt(scored._id);
      console.log('[quizController] Claude evaluation completed for attempt', scored._id);
    } catch (evalErr) {
      console.error('[quizController] Claude evaluation failed (non-fatal):', evalErr.message);
    }

    const quiz = await Quiz.findById(req.params.id);
    quiz.status = 'completed';
    await quiz.save();

    // Sync quiz progress with active journey
    try {
      const journey = await Journey.findOne({ userId: req.user.userId, status: 'active' });
      if (journey) {
        await journeyProgressService.syncQuizProgress(journey, req.user.userId);
      }
    } catch (e) {
      console.error('[quizController] Journey quiz sync error:', e.message);
    }

    // Re-fetch the attempt to include Claude evaluation results
    const finalAttempt = await QuizAttempt.findById(scored._id);
    res.json(apiResponse.success(finalAttempt, 'Quiz completed'));
  } catch (err) { next(err); }
};

const getResults = async (req, res, next) => {
  try {
    const attempt = await QuizAttempt.findOne({
      quizId: req.params.id, userId: req.user.userId, status: 'completed',
    });
    if (!attempt) throw new ApiError(404, 'No completed attempt found');

    const quiz = await Quiz.findById(req.params.id).lean();
    const topic = quiz?.topic;

    // Enrich with knowledge profile context, recommendations, and journey impact
    const [knowledgeProfile, journey] = await Promise.all([
      KnowledgeProfile.findOne({ userId: req.user.userId }),
      Journey.findOne({ userId: req.user.userId, status: 'active' }),
    ]);

    // 1. Competency level for the topic
    const topicMastery = knowledgeProfile?.topicMastery.find(t => t.topic === topic);
    const competency = topicMastery ? {
      topic,
      level: topicMastery.level,
      score: topicMastery.score,
      quizzesTaken: topicMastery.quizzesTaken,
      trend: topicMastery.trend,
      scoreHistory: (topicMastery.scoreHistory || []).slice(-5).map(h => ({
        score: h.score,
        date: h.date,
      })),
    } : null;

    // 2. Recommended content for weak areas
    let recommendedContent = [];
    const weakConcepts = attempt.analysis?.weaknesses || [];
    if (weakConcepts.length > 0) {
      // Find content covering weak concepts that user hasn't consumed
      const consumedIds = (await ContentProgress.find({ userId: req.user.userId }, { contentId: 1 }).lean())
        .map(p => p.contentId);

      const candidates = await Content.find({
        status: 'published',
        topics: { $in: weakConcepts },
        _id: { $nin: consumedIds },
      })
        .sort({ 'aiData.qualityScore': -1 })
        .limit(5)
        .lean();

      recommendedContent = candidates.map(c => ({
        _id: c._id,
        title: c.title,
        contentType: c.contentType,
        domain: c.domain,
        topics: c.topics,
        duration: c.duration,
        thumbnailUrl: c.thumbnailUrl,
        creator: c.creator,
        sourceType: c.sourceType,
        difficulty: c.difficulty,
        _reason: `Strengthen your ${c.topics.filter(t => weakConcepts.includes(t)).join(', ')} skills`,
      }));
    }

    // Also get gap-filling recs from the recommendation engine if we didn't find enough
    if (recommendedContent.length < 3 && topic) {
      try {
        const gapRecs = await recommendationService.getGapFillingRecommendations(req.user.userId, { limit: 5 });
        const existingIds = new Set(recommendedContent.map(c => c._id.toString()));
        for (const item of (gapRecs.items || [])) {
          if (!existingIds.has(item._id.toString()) && recommendedContent.length < 5) {
            recommendedContent.push({
              _id: item._id,
              title: item.title,
              contentType: item.contentType,
              domain: item.domain,
              topics: item.topics,
              duration: item.duration,
              thumbnailUrl: item.thumbnailUrl,
              creator: item.creator,
              sourceType: item.sourceType,
              difficulty: item.difficulty,
              _reason: 'Recommended to fill knowledge gaps',
            });
          }
        }
      } catch (_) { /* Non-critical */ }
    }

    // 3. Journey impact — what changed in the journey as a result
    let journeyImpact = null;
    if (journey) {
      const score = attempt.score?.percentage || 0;
      journeyImpact = {
        currentWeek: journey.currentWeek,
        totalWeeks: journey.weeklyPlans?.length || 0,
        overallProgress: journey.progress?.overallPercentage || 0,
        adaptationHint: score >= 90
          ? 'Excellent! Your journey may accelerate based on this performance.'
          : score >= 70
            ? 'Good progress! Your journey continues as planned.'
            : score >= 50
              ? 'Your journey may add review material to strengthen this topic.'
              : 'Your journey will adapt to help you build a stronger foundation here.',
      };
    }

    // 4. Next action suggestions
    const nextActions = [];
    if (recommendedContent.length > 0) {
      nextActions.push({
        type: 'study_weak_areas',
        label: `Study ${weakConcepts.slice(0, 2).join(' & ')}`,
        contentId: recommendedContent[0]._id,
      });
    }
    if (journey) {
      nextActions.push({
        type: 'continue_journey',
        label: 'Continue Your Learning Journey',
      });
    }
    nextActions.push({
      type: 'explore_topic',
      label: `Explore more ${topic || 'content'}`,
      topic,
    });

    const enrichedResult = {
      ...attempt.toObject(),
      competency,
      recommendedContent,
      journeyImpact,
      nextActions,
    };

    res.json(apiResponse.success(enrichedResult));
  } catch (err) { next(err); }
};

const getTriggerStatus = async (req, res, next) => {
  try {
    const trigger = await QuizTrigger.findOne({
      _id: req.params.triggerId,
      userId: req.user.userId,
    });
    if (!trigger) throw new ApiError(404, 'Trigger not found');

    const result = {
      triggerId: trigger._id,
      status: trigger.status,
      topic: trigger.topic,
      quizId: trigger.quizId || null,
    };

    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

const getPendingQuizzes = async (req, res, next) => {
  try {
    // Get the user's primary/active objective for scoping
    const activeObjective = await UserObjective.findOne({
      userId: req.user.userId,
      isPrimary: true,
      status: 'active',
    });

    let quizQuery = { userId: req.user.userId, status: { $in: ['ready', 'delivered'] } };
    if (activeObjective) {
      // Show quizzes for active objective OR legacy quizzes with no objective tag
      quizQuery.$or = [
        { objectiveId: activeObjective._id },
        { objectiveId: null },
        { objectiveId: { $exists: false } },
      ];
    }

    const quizzes = await Quiz.find(quizQuery)
      .sort({ createdAt: -1 }).select('_id title topic type totalQuestions createdAt');
    res.json(apiResponse.success(quizzes));
  } catch (err) { next(err); }
};

const getSkillAssessments = async (req, res, next) => {
  try {
    const quizzes = await Quiz.find({
      userId: req.user.userId,
      type: 'competency_assessment',
      status: { $in: ['ready', 'delivered', 'in_progress', 'completed'] },
    }).sort({ createdAt: -1 }).select('-questions.correctAnswer -questions.explanation');
    res.json(apiResponse.success(quizzes));
  } catch (err) { next(err); }
};

module.exports = { listQuizzes, getHistory, requestOnDemand, getQuiz, startAttempt, submitAnswer, completeQuiz, getResults, getTriggerStatus, getPendingQuizzes, getSkillAssessments };
