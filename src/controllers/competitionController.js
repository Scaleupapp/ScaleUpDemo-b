// src/controllers/competitionController.js
const competitionService = require('../services/competitionService');
const liveEventService = require('../services/liveEventService');
const challengeGenerationService = require('../services/challengeGenerationService');
const apiResponse = require('../utils/apiResponse');

// --- Daily Challenges ---

const getTodayChallenges = async (req, res, next) => {
  try {
    const challenges = await competitionService.getTodayChallenges();
    const ChallengeAttempt = require('../models/ChallengeAttempt');
    const userId = req.user?.userId;

    // Enrich with per-user completion data
    const enriched = await Promise.all(challenges.map(async (ch) => {
      const obj = ch.toObject();
      if (userId) {
        const attempt = await ChallengeAttempt.findOne({
          userId,
          challengeId: ch._id,
          completedAt: { $ne: null },
        }).lean();
        obj.userCompleted = !!attempt;
        obj.userScore = attempt?.handicappedScore || null;
      }
      return obj;
    }));

    res.json(apiResponse.success(enriched));
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

const getChallengeReview = async (req, res, next) => {
  try {
    const result = await competitionService.getChallengeReview(req.user.userId, req.params.id);
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
    const LiveEventAttempt = require('../models/LiveEventAttempt');
    const userId = req.user?.userId;

    const enriched = await Promise.all(events.map(async (ev) => {
      const obj = ev.toObject();
      if (userId) {
        const attempt = await LiveEventAttempt.findOne({ userId, eventId: ev._id }).lean();
        obj.userJoined = !!attempt;
      }
      return obj;
    }));

    res.json(apiResponse.success(enriched));
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

/**
 * V2: "What's relevant for this user RIGHT NOW?"
 *
 * Returns the best matching today-challenge for the user's objective topic
 * (or any available challenge if no topic match), the next upcoming live
 * event, and a status flag the iOS client uses to decide between rendering
 * the entry point or a "building today's challenge" waiting state.
 *
 * Used by:
 *   - Home (when surfacing competition as a today task)
 *   - Compass "Compete" chip
 *   - Competition Home destination
 */
const getRelevantForUser = async (req, res, next) => {
  try {
    const competitionService = require('../services/competitionService');
    const UserObjective = require('../models/UserObjective');
    const DailyChallenge = require('../models/DailyChallenge');

    // Resolve the user's primary objective topic via canonicalTopic (single DB hit).
    const objective = await UserObjective.findOne(
      { userId: req.user.userId, status: 'active', isPrimary: true },
      { canonicalTopic: 1, objectiveType: 1 }
    ).lean();

    const canonicalTopic = objective?.canonicalTopic || null;

    // Today's challenges + upcoming events in parallel.
    const [allToday, upcomingEvents] = await Promise.all([
      competitionService.getTodayChallenges(),
      competitionService.getUpcomingEvents
        ? competitionService.getUpcomingEvents({ limit: 1 }).catch(() => [])
        : Promise.resolve([]),
    ]);

    // Prefer the challenge whose topic exactly matches the user's canonicalTopic
    // — falls back to any active challenge so we always offer something.
    const matchByTopic = canonicalTopic
      ? (allToday || []).find(c => c.topic === canonicalTopic)
      : null;
    const challenge = matchByTopic || (allToday && allToday[0]) || null;

    // Has the user already attempted today's challenge? (only meaningful when
    // one is available — used to hide it from "today's tasks" once played.)
    let alreadyPlayed = false;
    if (challenge) {
      const ChallengeAttempt = require('../models/ChallengeAttempt');
      alreadyPlayed = !!(await ChallengeAttempt.exists({
        userId: req.user.userId, challengeId: challenge._id, status: 'completed',
      }));
    }

    // Cohort hints surfaced under the iOS challenge card.
    const CohortDirectory = require('../models/CohortDirectory');
    let cohortMemberCount = 0;
    let cohortPlayedToday = 0;
    if (canonicalTopic) {
      const dir = await CohortDirectory.findOne({ canonicalTopic }).select('memberCount').lean();
      cohortMemberCount = dir?.memberCount || 0;
      if (challenge) {
        const ChallengeAttempt = require('../models/ChallengeAttempt');
        cohortPlayedToday = await ChallengeAttempt.countDocuments({
          challengeId: challenge._id, status: 'completed',
        });
      }
    }

    // Status flag for the iOS waiting screen. challenge=null means today's
    // batch hasn't been generated yet (cron hasn't fired, or the topic pool
    // is empty for this user's objective).
    const status = challenge
      ? (alreadyPlayed ? 'played' : 'available')
      : 'building';

    return res.json(apiResponse.success({
      status,
      objectiveTopic: canonicalTopic,
      topicMatch: !!matchByTopic,
      cohortMemberCount,
      cohortPlayedToday,
      todayChallenge: challenge ? {
        _id: challenge._id,
        title: challenge.title,
        topic: challenge.topic,
        difficulty: challenge.difficulty,
        questionCount: challenge.questions?.length || 0,
        durationSeconds: challenge.totalDurationSeconds || (challenge.questions?.length || 0) * 30,
      } : null,
      nextLiveEvent: (upcomingEvents && upcomingEvents[0]) ? {
        _id: upcomingEvents[0]._id,
        scheduledFor: upcomingEvents[0].scheduledStartAt || upcomingEvents[0].startsAt,
        title: upcomingEvents[0].title,
        topic: upcomingEvents[0].topic,
      } : null,
    }));
  } catch (err) { next(err); }
};

module.exports = {
  getTodayChallenges, getChallengeById, startChallenge, submitChallengeAnswer,
  completeChallenge, getChallengeResults, getChallengeReview,
  getWeeklyLeaderboard, getAllTimeLeaderboard,
  getCompetitionProfile, getCompetitionStats,
  getUpcomingEvents, getEventById, joinLobby, getLobbyState,
  getCurrentQuestion, submitLiveAnswer, getQuestionResults, getEventResults,
  getChallengeCandidates, approveCandidates, triggerGeneration,
  getObjectiveTopic,
  getRelevantForUser,
};
