const Journey = require('../models/Journey');
const journeyGenerationService = require('../services/journeyGenerationService');
const apiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

const getActiveJourney = async (req, res, next) => {
  try {
    const journey = await Journey.findOne({ userId: req.user.userId, status: 'active' });
    res.json(apiResponse.success(journey));
  } catch (err) { next(err); }
};

const generateJourney = async (req, res, next) => {
  try {
    const { objectiveId } = req.body;
    const journey = await journeyGenerationService.generateJourney(req.user.userId, objectiveId);
    res.status(201).json(apiResponse.success(journey, 'Journey generated'));
  } catch (err) { next(err); }
};

const getTodayPlan = async (req, res, next) => {
  try {
    const journey = await Journey.findOne({ userId: req.user.userId, status: 'active' });
    if (!journey) throw new ApiError(404, 'No active journey');
    const currentWeekPlan = journey.weeklyPlans.find(w => w.weekNumber === journey.currentWeek);
    const dayOfWeek = new Date().getDay() || 7;
    const todayPlan = currentWeekPlan?.dailyAssignments.find(d => d.day === dayOfWeek);
    res.json(apiResponse.success({ weekNumber: journey.currentWeek, day: dayOfWeek, plan: todayPlan, weekGoals: currentWeekPlan?.goals }));
  } catch (err) { next(err); }
};

const getWeekPlan = async (req, res, next) => {
  try {
    const journey = await Journey.findOne({ userId: req.user.userId, status: 'active' });
    if (!journey) throw new ApiError(404, 'No active journey');
    const weekPlan = journey.weeklyPlans.find(w => w.weekNumber === parseInt(req.params.weekNumber));
    if (!weekPlan) throw new ApiError(404, 'Week plan not found');
    res.json(apiResponse.success(weekPlan));
  } catch (err) { next(err); }
};

const pauseJourney = async (req, res, next) => {
  try {
    const journey = await Journey.findOneAndUpdate(
      { userId: req.user.userId, status: 'active' },
      { status: 'paused' }, { new: true }
    );
    res.json(apiResponse.success(journey, 'Journey paused'));
  } catch (err) { next(err); }
};

const resumeJourney = async (req, res, next) => {
  try {
    const journey = await Journey.findOneAndUpdate(
      { userId: req.user.userId, status: 'paused' },
      { status: 'active' }, { new: true }
    );
    res.json(apiResponse.success(journey, 'Journey resumed'));
  } catch (err) { next(err); }
};

const getMilestones = async (req, res, next) => {
  try {
    const journey = await Journey.findOne({ userId: req.user.userId, status: { $in: ['active', 'paused'] } });
    res.json(apiResponse.success(journey?.milestones || []));
  } catch (err) { next(err); }
};

const getProgress = async (req, res, next) => {
  try {
    const journey = await Journey.findOne({ userId: req.user.userId, status: { $in: ['active', 'paused'] } });
    res.json(apiResponse.success(journey?.progress || {}));
  } catch (err) { next(err); }
};

const getAdaptations = async (req, res, next) => {
  try {
    const journey = await Journey.findOne({ userId: req.user.userId, status: { $in: ['active', 'paused'] } });
    res.json(apiResponse.success(journey?.adaptationHistory || []));
  } catch (err) { next(err); }
};

module.exports = { getActiveJourney, generateJourney, getTodayPlan, getWeekPlan, pauseJourney, resumeJourney, getMilestones, getProgress, getAdaptations };
