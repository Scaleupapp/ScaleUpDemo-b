// src/controllers/competitionController.js
const competitionService = require('../services/competitionService');
const liveEventService = require('../services/liveEventService');
const challengeGenerationService = require('../services/challengeGenerationService');
const apiResponse = require('../utils/apiResponse');

// --- Daily Challenges ---

const getTodayChallenges = async (req, res, next) => {
  try {
    const challenges = await competitionService.getTodayChallenges();
    res.json(apiResponse.success(challenges));
  } catch (err) { next(err); }
};

const getChallengeById = async (req, res, next) => {
  try {
    const challenge = await competitionService.getChallengeById(req.params.id);
    if (!challenge) return res.status(404).json(apiResponse.error('Challenge not found'));
    res.json(apiResponse.success(challenge));
  } catch (err) { next(err); }
};

const startChallenge = async (req, res, next) => {
  try {
    const result = await competitionService.startChallenge(req.user.userId, req.params.id);
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

const submitChallengeAnswer = async (req, res, next) => {
  try {
    const { questionIndex, selectedAnswer, timeSpent } = req.body;
    const result = await competitionService.submitAnswer(req.user.userId, req.params.id, questionIndex, selectedAnswer, timeSpent);
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

const completeChallenge = async (req, res, next) => {
  try {
    const result = await competitionService.completeChallenge(req.user.userId, req.params.id);
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

const getChallengeResults = async (req, res, next) => {
  try {
    const result = await competitionService.getChallengeResults(req.user.userId, req.params.id);
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

// --- Leaderboard ---

const getWeeklyLeaderboard = async (req, res, next) => {
  try {
    const { topic, weekStart } = req.query;
    const board = await competitionService.getWeeklyLeaderboard(topic || 'global', weekStart ? new Date(weekStart) : null);
    res.json(apiResponse.success(board));
  } catch (err) { next(err); }
};

const getAllTimeLeaderboard = async (req, res, next) => {
  try {
    const { topic } = req.query;
    const board = await competitionService.getAllTimeLeaderboard(topic);
    res.json(apiResponse.success(board));
  } catch (err) { next(err); }
};

// --- Profile & Stats ---

const getCompetitionProfile = async (req, res, next) => {
  try {
    const profile = await competitionService.getCompetitionProfile(req.user.userId);
    res.json(apiResponse.success(profile));
  } catch (err) { next(err); }
};

const getCompetitionStats = async (req, res, next) => {
  try {
    const stats = await competitionService.getCompetitionStats(req.user.userId);
    res.json(apiResponse.success(stats));
  } catch (err) { next(err); }
};

// --- Live Events ---

const getUpcomingEvents = async (req, res, next) => {
  try {
    const events = await liveEventService.getUpcomingEvents();
    res.json(apiResponse.success(events));
  } catch (err) { next(err); }
};

const getEventById = async (req, res, next) => {
  try {
    const event = await liveEventService.getEventById(req.params.id);
    if (!event) return res.status(404).json(apiResponse.error('Event not found'));
    res.json(apiResponse.success(event));
  } catch (err) { next(err); }
};

const joinLobby = async (req, res, next) => {
  try {
    const result = await liveEventService.joinLobby(req.user.userId, req.params.id);
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

const getLobbyState = async (req, res, next) => {
  try {
    const state = await liveEventService.getLobbyState(req.params.id);
    res.json(apiResponse.success(state));
  } catch (err) { next(err); }
};

const getCurrentQuestion = async (req, res, next) => {
  try {
    const question = await liveEventService.getCurrentQuestion(req.user.userId, req.params.id);
    res.json(apiResponse.success(question));
  } catch (err) { next(err); }
};

const submitLiveAnswer = async (req, res, next) => {
  try {
    const { questionIndex, selectedAnswer, timeSpent } = req.body;
    const result = await liveEventService.submitLiveAnswer(req.user.userId, req.params.id, questionIndex, selectedAnswer, timeSpent);
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

const getQuestionResults = async (req, res, next) => {
  try {
    const { questionIndex } = req.query;
    const results = await liveEventService.getQuestionResults(req.params.id, parseInt(questionIndex));
    res.json(apiResponse.success(results));
  } catch (err) { next(err); }
};

const getEventResults = async (req, res, next) => {
  try {
    const results = await liveEventService.getEventResults(req.user.userId, req.params.id);
    res.json(apiResponse.success(results));
  } catch (err) { next(err); }
};

// --- Admin ---

const getChallengeCandidates = async (req, res, next) => {
  try {
    const { week } = req.query;
    const filter = week ? { weekOf: new Date(week) } : {};
    const banks = await require('../models/ChallengeCandidateBank').find(filter).sort({ createdAt: -1 });
    res.json(apiResponse.success(banks));
  } catch (err) { next(err); }
};

const approveCandidates = async (req, res, next) => {
  try {
    const bank = await challengeGenerationService.autoAssignQuestions(req.params.id);
    res.json(apiResponse.success(bank, 'Questions assigned'));
  } catch (err) { next(err); }
};

const triggerGeneration = async (req, res, next) => {
  try {
    const results = await challengeGenerationService.generateWeeklyCandidates();
    res.json(apiResponse.success(results, 'Generation complete'));
  } catch (err) { next(err); }
};

const getObjectiveTopic = async (req, res, next) => {
  try {
    const UserObjective = require('../models/UserObjective');
    const objective = await UserObjective.findOne(
      { userId: req.user.userId, status: 'active', isPrimary: true },
      { objectiveType: 1, specifics: 1, topicsOfInterest: 1 }
    ).lean();

    let topic = null;
    if (objective) {
      switch (objective.objectiveType) {
        case 'upskilling':
          topic = objective.specifics?.targetSkill; break;
        case 'interview_preparation':
          topic = objective.specifics?.targetRole; break;
        case 'exam_preparation':
          topic = objective.specifics?.examName; break;
        case 'career_switch':
          topic = objective.specifics?.toDomain; break;
        default:
          topic = objective.topicsOfInterest?.[0];
      }
    }
    res.json(apiResponse.success({ topic: topic || null }));
  } catch (err) { next(err); }
};

module.exports = {
  getTodayChallenges, getChallengeById, startChallenge, submitChallengeAnswer,
  completeChallenge, getChallengeResults,
  getWeeklyLeaderboard, getAllTimeLeaderboard,
  getCompetitionProfile, getCompetitionStats,
  getUpcomingEvents, getEventById, joinLobby, getLobbyState,
  getCurrentQuestion, submitLiveAnswer, getQuestionResults, getEventResults,
  getChallengeCandidates, approveCandidates, triggerGeneration,
  getObjectiveTopic,
};
