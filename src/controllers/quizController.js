const Quiz = require('../models/Quiz');
const QuizAttempt = require('../models/QuizAttempt');
const QuizTrigger = require('../models/QuizTrigger');
const quizTriggerService = require('../services/quizTriggerService');
const quizScoringService = require('../services/quizScoringService');
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
      .populate('quizId', 'title topic type');
    res.json(apiResponse.success(attempts));
  } catch (err) { next(err); }
};

const requestOnDemand = async (req, res, next) => {
  try {
    const { topic, contentIds } = req.body;
    const trigger = await quizTriggerService.triggerOnDemand(req.user.userId, { topic, contentIds });
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
    const { questionIndex, selectedAnswer, timeTaken } = req.body;

    const attempt = await QuizAttempt.findOne({
      quizId: req.params.id, userId: req.user.userId, status: 'in_progress',
    });
    if (!attempt) throw new ApiError(404, 'No active attempt found');

    const existingIdx = attempt.answers.findIndex(a => a.questionIndex === questionIndex);
    const answerData = { questionIndex, selectedAnswer, timeTaken };

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

    const quiz = await Quiz.findById(req.params.id);
    quiz.status = 'completed';
    await quiz.save();

    res.json(apiResponse.success(scored, 'Quiz completed'));
  } catch (err) { next(err); }
};

const getResults = async (req, res, next) => {
  try {
    const attempt = await QuizAttempt.findOne({
      quizId: req.params.id, userId: req.user.userId, status: 'completed',
    });
    if (!attempt) throw new ApiError(404, 'No completed attempt found');
    res.json(apiResponse.success(attempt));
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

module.exports = { listQuizzes, getHistory, requestOnDemand, getQuiz, startAttempt, submitAnswer, completeQuiz, getResults, getTriggerStatus };
