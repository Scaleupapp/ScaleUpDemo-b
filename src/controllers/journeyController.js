const Journey = require('../models/Journey');
const Content = require('../models/Content');
const ContentProgress = require('../models/ContentProgress');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const UserObjective = require('../models/UserObjective');
const journeyGenerationService = require('../services/journeyGenerationService');
const journeyProgressService = require('../services/journeyProgressService');
const apiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { updateStreak } = require('../services/streakService');

/**
 * Calculate active elapsed time for a journey, excluding paused periods.
 */
function getActiveElapsedMs(journey) {
  const now = Date.now();
  const totalElapsed = now - new Date(journey.createdAt).getTime();
  let pausedMs = journey.pausedDuration || 0;

  // If currently paused, add the ongoing pause duration too
  if (journey.pausedAt) {
    pausedMs += now - new Date(journey.pausedAt).getTime();
  }

  return Math.max(0, totalElapsed - pausedMs);
}

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

    // Sync progress first
    await journeyProgressService.syncProgress(journey, req.user.userId);

    const currentWeekPlan = journey.weeklyPlans.find(w => w.weekNumber === journey.currentWeek);
    const dayOfWeek = new Date().getDay() || 7;
    const todayPlan = currentWeekPlan?.dailyAssignments.find(d => d.day === dayOfWeek);

    const contentIds = todayPlan?.contentIds || [];

    // Fetch content items and their progress in parallel
    const [contentItems, progressDocs, knowledgeProfile] = await Promise.all([
      Content.find({ _id: { $in: contentIds } }).lean(),
      ContentProgress.find({ userId: req.user.userId, contentId: { $in: contentIds } }).lean(),
      KnowledgeProfile.findOne({ userId: req.user.userId }),
    ]);

    // Build a progress lookup map (ContentProgress uses isCompleted + percentageCompleted, not status)
    const progressMap = {};
    for (const p of progressDocs) {
      progressMap[p.contentId.toString()] = {
        status: p.isCompleted ? 'completed' : (p.percentageCompleted > 0 ? 'in_progress' : 'not_started'),
        progressPercentage: p.percentageCompleted || 0,
        completedAt: p.completedAt,
      };
    }

    // Enrich each content item with its completion status
    const enrichedContent = contentItems.map(c => ({
      ...c,
      _progress: progressMap[c._id.toString()] || { status: 'not_started', progressPercentage: 0 },
    }));

    // Calculate today's completion stats
    const totalItems = enrichedContent.length;
    const completedItems = enrichedContent.filter(c => c._progress.status === 'completed').length;
    const inProgressItems = enrichedContent.filter(c => c._progress.status === 'in_progress').length;

    // Topic mastery snapshot for today's topics
    const todayTopics = [...new Set(contentItems.flatMap(c => c.topics || []))];
    const topicMastery = todayTopics.map(topic => {
      const entry = knowledgeProfile?.topicMastery.find(t => t.topic === topic);
      return {
        topic,
        score: entry?.score || 0,
        level: entry?.level || 'not_started',
        trend: entry?.trend || 'stable',
      };
    });

    // Journey progress overview
    const journeyProgress = {
      currentWeek: journey.currentWeek,
      totalWeeks: journey.weeklyPlans?.length || 0,
      overallPercentage: journey.progress?.overallPercentage || 0,
      weekCompletedDays: currentWeekPlan?.dailyAssignments.filter(d => d.completed).length || 0,
      weekTotalDays: currentWeekPlan?.dailyAssignments.length || 0,
    };

    res.json(apiResponse.success({
      weekNumber: journey.currentWeek,
      day: dayOfWeek,
      plan: todayPlan,
      contentItems: enrichedContent,
      weekGoals: currentWeekPlan?.goals,
      todayStats: { totalItems, completedItems, inProgressItems },
      topicMastery,
      journeyProgress,
    }));
  } catch (err) { next(err); }
};

const getWeekPlan = async (req, res, next) => {
  try {
    const journey = await Journey.findOne({ userId: req.user.userId, status: 'active' });
    if (!journey) throw new ApiError(404, 'No active journey');
    const weekPlan = journey.weeklyPlans.find(w => w.weekNumber === parseInt(req.params.weekNumber));
    if (!weekPlan) throw new ApiError(404, 'Week plan not found');

    // Collect all contentIds from all daily assignments in the week
    const allContentIds = weekPlan.dailyAssignments.reduce((ids, d) => {
      if (d.contentIds && d.contentIds.length > 0) ids.push(...d.contentIds);
      return ids;
    }, []);

    // Fetch content, progress, and knowledge profile in parallel
    const [contentItems, progressDocs, knowledgeProfile] = await Promise.all([
      Content.find({ _id: { $in: allContentIds } }).lean(),
      ContentProgress.find({ userId: req.user.userId, contentId: { $in: allContentIds } }).lean(),
      KnowledgeProfile.findOne({ userId: req.user.userId }),
    ]);

    // Build progress lookup (ContentProgress uses isCompleted + percentageCompleted, not status)
    const progressMap = {};
    for (const p of progressDocs) {
      progressMap[p.contentId.toString()] = {
        status: p.isCompleted ? 'completed' : (p.percentageCompleted > 0 ? 'in_progress' : 'not_started'),
        progressPercentage: p.percentageCompleted || 0,
        completedAt: p.completedAt,
      };
    }

    // Enrich content items
    const enrichedContent = contentItems.map(c => ({
      ...c,
      _progress: progressMap[c._id.toString()] || { status: 'not_started', progressPercentage: 0 },
    }));

    // Week-level stats
    const totalItems = enrichedContent.length;
    const completedItems = enrichedContent.filter(c => c._progress.status === 'completed').length;
    const completedDays = weekPlan.dailyAssignments.filter(d => d.completed).length;
    const totalDays = weekPlan.dailyAssignments.length;

    // Topic mastery for the week's topics
    const weekTopics = [...new Set(contentItems.flatMap(c => c.topics || []))];
    const topicMastery = weekTopics.map(topic => {
      const entry = knowledgeProfile?.topicMastery.find(t => t.topic === topic);
      return {
        topic,
        score: entry?.score || 0,
        level: entry?.level || 'not_started',
        trend: entry?.trend || 'stable',
      };
    });

    res.json(apiResponse.success({
      weekPlan,
      contentItems: enrichedContent,
      weekStats: { totalItems, completedItems, completedDays, totalDays },
      topicMastery,
      isCurrentWeek: weekPlan.weekNumber === journey.currentWeek,
    }));
  } catch (err) { next(err); }
};

const pauseJourney = async (req, res, next) => {
  try {
    const journey = await Journey.findOneAndUpdate(
      { userId: req.user.userId, status: 'active' },
      { status: 'paused', pausedAt: new Date(), lastResumedAt: null },
      { new: true }
    );
    res.json(apiResponse.success(journey, 'Journey paused'));
  } catch (err) { next(err); }
};

const resumeJourney = async (req, res, next) => {
  try {
    // First fetch the journey to calculate accumulated paused duration
    const journey = await Journey.findOne({ userId: req.user.userId, status: 'paused' });
    if (!journey) {
      return res.json(apiResponse.success(null, 'Journey resumed'));
    }

    // Accumulate time spent paused into pausedDuration
    if (journey.pausedAt) {
      const pausedMs = Date.now() - new Date(journey.pausedAt).getTime();
      journey.pausedDuration = (journey.pausedDuration || 0) + pausedMs;
    }
    journey.pausedAt = null;
    journey.lastResumedAt = new Date();
    journey.status = 'active';
    await journey.save();

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

const completeAssignment = async (req, res, next) => {
  try {
    const { weekNumber, day } = req.body;
    const journey = await Journey.findOne({ userId: req.user.userId, status: 'active' });
    if (!journey) throw new ApiError(404, 'No active journey');

    const week = journey.weeklyPlans.find(w => w.weekNumber === weekNumber);
    if (!week) throw new ApiError(404, 'Week not found');

    const assignment = week.dailyAssignments.find(d => d.day === day);
    if (!assignment) throw new ApiError(404, 'Assignment not found');

    assignment.completed = true;
    assignment.completedAt = new Date();

    // Update progress — use content-level granularity consistent with syncProgress
    const contentBreakdownResult = await journeyProgressService.getContentBreakdown(journey, req.user.userId);
    journey.progress.overallPercentage = Math.round((contentBreakdownResult.contentCompleted / Math.max(contentBreakdownResult.contentAssigned, 1)) * 100);
    journey.progress.contentConsumed = contentBreakdownResult.contentCompleted;
    journey.progress.contentAssigned = contentBreakdownResult.contentAssigned;

    await journey.save();

    // Update learning streak
    try { await updateStreak(req.user.userId); } catch (e) {
      console.error('[journeyController] Streak update error:', e.message);
    }

    res.json(apiResponse.success({ assignment, progress: journey.progress }));
  } catch (err) { next(err); }
};

/**
 * Enriched journey dashboard — combines journey state, objective, progress,
 * phase info, pace estimation, milestones, topic mastery, and next actions
 * into a single response for the GPS view.
 */
const getDashboard = async (req, res, next) => {
  try {
    const { objectiveId } = req.query;

    let journeyQuery = { userId: req.user.userId, status: { $in: ['active', 'paused'] } };
    if (objectiveId) {
      journeyQuery.objectiveId = objectiveId;
    }
    const journey = await Journey.findOne(journeyQuery).sort({ status: 1 }); // 'active' sorts before 'paused'
    if (!journey) throw new ApiError(404, 'No active journey');

    // Sync progress: reconcile content watched before/outside the journey
    await journeyProgressService.syncProgress(journey, req.user.userId);

    // Fetch objective, knowledge profile, and content breakdown in parallel
    const [objective, knowledgeProfile, contentBreakdown] = await Promise.all([
      UserObjective.findById(journey.objectiveId).lean(),
      KnowledgeProfile.findOne({ userId: req.user.userId }),
      journeyProgressService.getContentBreakdown(journey, req.user.userId),
    ]);

    // Current week info
    const currentWeekPlan = journey.weeklyPlans.find(w => w.weekNumber === journey.currentWeek);
    const dayOfWeek = new Date().getDay() || 7;
    const todayAssignment = currentWeekPlan?.dailyAssignments.find(d => d.day === dayOfWeek);

    // Fetch today's content for the dashboard
    const todayContentIds = todayAssignment?.contentIds || [];
    const [todayContent, todayProgress] = await Promise.all([
      Content.find({ _id: { $in: todayContentIds } }).lean(),
      ContentProgress.find({ userId: req.user.userId, contentId: { $in: todayContentIds } }).lean(),
    ]);

    const todayProgressMap = {};
    for (const p of todayProgress) {
      todayProgressMap[p.contentId.toString()] = {
        status: p.isCompleted ? 'completed' : (p.percentageCompleted > 0 ? 'in_progress' : 'not_started'),
        progressPercentage: p.percentageCompleted || 0,
      };
    }

    const enrichedTodayContent = todayContent.map(c => ({
      ...c,
      _progress: todayProgressMap[c._id.toString()] || { status: 'not_started', progressPercentage: 0 },
    }));

    // Week-level completion
    const weekDaysSummary = (currentWeekPlan?.dailyAssignments || []).map(d => ({
      day: d.day,
      completed: d.completed || false,
      contentCount: d.contentIds?.length || 0,
      topics: d.topics || [],
    }));

    // Overall week progress
    const totalWeekContent = (currentWeekPlan?.dailyAssignments || []).reduce(
      (sum, d) => sum + (d.contentIds?.length || 0), 0
    );
    const completedWeekDays = (currentWeekPlan?.dailyAssignments || []).filter(d => d.completed).length;

    // --- Current Phase info ---
    const currentPhase = journey.phases?.[journey.currentPhaseIndex || 0];

    // Per-phase content breakdown: group weeklyPlan contentIds by phaseIndex
    const phaseContentMap = {}; // phaseIndex -> Set of contentId strings
    for (const week of journey.weeklyPlans) {
      const pi = week.phaseIndex ?? 0;
      if (!phaseContentMap[pi]) phaseContentMap[pi] = new Set();
      for (const assignment of week.dailyAssignments) {
        for (const cid of (assignment.contentIds || [])) {
          phaseContentMap[pi].add(cid.toString());
        }
      }
    }
    // Fetch all journey content progress in one query
    const allJourneyContentIds = journey.weeklyPlans.flatMap(w =>
      w.dailyAssignments.flatMap(d => d.contentIds || [])
    );
    const allProgressDocs = await ContentProgress.find({
      userId: req.user.userId,
      contentId: { $in: allJourneyContentIds },
      isCompleted: true,
    }).lean();
    const completedContentSet = new Set(allProgressDocs.map(p => p.contentId.toString()));

    const phases = (journey.phases || []).map((p, i) => {
      const contentIds = phaseContentMap[i] || new Set();
      const consumed = [...contentIds].filter(id => completedContentSet.has(id)).length;
      return {
        name: p.name,
        type: p.type,
        order: p.order,
        status: p.status || (i < (journey.currentPhaseIndex || 0) ? 'completed' : i === (journey.currentPhaseIndex || 0) ? 'active' : 'upcoming'),
        focusTopics: p.focusTopics || [],
        objectives: p.objectives || [],
        contentAssigned: contentIds.size,
        contentConsumed: consumed,
      };
    });

    // --- Pace estimation ---
    const totalWeeks = journey.weeklyPlans?.length || 1;
    const weeksElapsed = journey.currentWeek || 1;
    const weeksRemaining = Math.max(0, totalWeeks - weeksElapsed);
    const overallPct = journey.progress?.overallPercentage || 0;

    // Calculate estimated completion date based on current pace
    let paceStatus = 'on_track'; // on_track, ahead, behind, at_risk
    let estimatedCompletionDate = null;
    let daysRemaining = null;

    if (objective?.targetDate) {
      const now = new Date();
      const target = new Date(objective.targetDate);
      daysRemaining = Math.max(0, Math.ceil((target - now) / (1000 * 60 * 60 * 24)));

      // Expected progress based on active elapsed time (excludes paused periods)
      const activeElapsedMs = getActiveElapsedMs(journey);
      const totalDuration = Math.ceil((target - new Date(journey.createdAt)) / (1000 * 60 * 60 * 24));
      const elapsed = Math.ceil(activeElapsedMs / (1000 * 60 * 60 * 24));
      const expectedPct = Math.min(100, Math.round((elapsed / Math.max(totalDuration, 1)) * 100));

      if (overallPct >= expectedPct + 15) paceStatus = 'ahead';
      else if (overallPct >= expectedPct - 10) paceStatus = 'on_track';
      else if (overallPct >= expectedPct - 25) paceStatus = 'behind';
      else paceStatus = 'at_risk';

      // Estimate completion based on current velocity
      if (overallPct > 0 && weeksElapsed > 0) {
        const pctPerWeek = overallPct / weeksElapsed;
        const weeksToFinish = pctPerWeek > 0 ? Math.ceil((100 - overallPct) / pctPerWeek) : totalWeeks;
        const estDate = new Date();
        estDate.setDate(estDate.getDate() + weeksToFinish * 7);
        estimatedCompletionDate = estDate;
      }
    } else {
      // No target date — estimate based on remaining weeks
      const estDate = new Date();
      estDate.setDate(estDate.getDate() + weeksRemaining * 7);
      estimatedCompletionDate = estDate;
    }

    // Topic mastery across the journey's topics
    const allJourneyTopics = [...new Set(
      journey.weeklyPlans.flatMap(w =>
        w.dailyAssignments.flatMap(d => d.topics || [])
      )
    )];
    const topicMastery = allJourneyTopics.map(topic => {
      const entry = knowledgeProfile?.topicMastery.find(t => t.topic === topic);
      return {
        topic,
        score: entry?.score || 0,
        level: entry?.level || 'not_started',
        trend: entry?.trend || 'stable',
        quizzesTaken: entry?.quizzesTaken || 0,
      };
    });

    // Milestone progress — compute scheduledWeek from scheduledDate or estimate from position
    const milestones = (journey.milestones || []).map((m, idx, arr) => {
      const mObj = m.toObject ? m.toObject() : m;
      let scheduledWeek = null;
      if (m.scheduledDate) {
        const sd = new Date(m.scheduledDate);
        const matchingWeek = journey.weeklyPlans.find(w => {
          if (!w.startDate || !w.endDate) return false;
          return sd >= new Date(w.startDate) && sd <= new Date(w.endDate);
        });
        scheduledWeek = matchingWeek?.weekNumber || null;
      }
      // Estimate week from milestone position if no scheduledDate
      if (!scheduledWeek && arr.length > 0) {
        scheduledWeek = Math.max(1, Math.round(((idx + 1) / arr.length) * totalWeeks));
      }
      return { ...mObj, scheduledWeek, isUpcoming: !m.completedAt };
    });
    const nextMilestone = milestones.find(m => m.isUpcoming);

    // Find next uncompleted content item across today
    const nextItem = enrichedTodayContent.find(c => c._progress.status !== 'completed');

    // Build next action
    let nextAction = null;
    if (nextItem) {
      nextAction = {
        type: 'continue_content',
        label: nextItem._progress.status === 'in_progress'
          ? `Continue: ${nextItem.title}`
          : `Start: ${nextItem.title}`,
        contentId: nextItem._id,
        contentType: nextItem.contentType,
        progressPercentage: nextItem._progress.progressPercentage,
      };
    } else if (todayAssignment && !todayAssignment.completed) {
      nextAction = { type: 'day_complete', label: 'All content done! Mark day as complete.' };
    } else {
      nextAction = { type: 'all_done_today', label: 'Great work! You\'re done for today.' };
    }

    res.json(apiResponse.success({
      // --- Objective context (the WHY) ---
      objective: objective ? {
        id: objective._id,
        objectiveType: objective.objectiveType,
        specifics: objective.specifics,
        timeline: objective.timeline,
        targetDate: objective.targetDate,
        currentLevel: objective.currentLevel,
        weeklyCommitHours: objective.weeklyCommitHours,
        daysRemaining,
      } : null,

      // --- Journey meta ---
      journey: {
        id: journey._id,
        title: journey.title,
        status: journey.status,
        currentWeek: journey.currentWeek,
        totalWeeks,
        createdAt: journey.createdAt,
      },

      // --- Current phase ---
      currentPhase: currentPhase ? {
        name: currentPhase.name,
        type: currentPhase.type,
        focusTopics: currentPhase.focusTopics || [],
        objectives: currentPhase.objectives || [],
      } : null,
      phases,

      // --- Progress + pace (uses synced data) ---
      progress: {
        overallPercentage: journey.progress?.overallPercentage || 0,
        contentAssigned: contentBreakdown.contentAssigned,
        contentConsumed: contentBreakdown.contentCompleted,
        contentInProgress: contentBreakdown.contentInProgress,
        milestonesTotal: journey.progress?.milestonesTotal || milestones.length,
        milestonesCompleted: journey.progress?.milestonesCompleted || milestones.filter(m => m.status === 'completed').length,
        quizzesCompleted: journey.progress?.quizzesCompleted || 0,
        quizzesAssigned: journey.progress?.quizzesAssigned || 0,
        currentStreak: journey.progress?.currentStreak || 0,
        longestStreak: journey.progress?.longestStreak || 0,
      },
      pace: {
        status: paceStatus,
        weeksRemaining,
        estimatedCompletionDate,
        daysRemaining,
      },

      // --- This week ---
      currentWeek: {
        weekNumber: journey.currentWeek,
        goals: currentWeekPlan?.goals || [],
        theme: currentWeekPlan?.theme,
        daysSummary: weekDaysSummary,
        completedDays: completedWeekDays,
        totalDays: currentWeekPlan?.dailyAssignments.length || 0,
        totalContent: totalWeekContent,
      },

      // --- Today ---
      today: {
        day: dayOfWeek,
        completed: todayAssignment?.completed || false,
        contentItems: enrichedTodayContent,
        todayStats: {
          totalItems: enrichedTodayContent.length,
          completedItems: enrichedTodayContent.filter(c => c._progress.status === 'completed').length,
          inProgressItems: enrichedTodayContent.filter(c => c._progress.status === 'in_progress').length,
        },
      },

      topicMastery,
      milestones,
      nextMilestone,
      nextAction,
    }));
  } catch (err) { next(err); }
};

const addMilestone = async (req, res, next) => {
  try {
    const { title, type, targetCriteria } = req.body;
    if (!title) throw new ApiError(400, 'Milestone title is required');

    const journey = await Journey.findOne({ userId: req.user.userId, status: 'active' });
    if (!journey) throw new ApiError(404, 'No active journey');

    const milestone = {
      title,
      type: type || 'custom',
      status: 'upcoming',
      targetCriteria: targetCriteria || {},
      isCustom: true,
    };

    journey.milestones.push(milestone);
    journey.progress.milestonesTotal = journey.milestones.length;
    await journey.save();

    res.status(201).json(apiResponse.success(journey.milestones, 'Milestone added'));
  } catch (err) { next(err); }
};

const deleteMilestone = async (req, res, next) => {
  try {
    const { milestoneId } = req.params;
    const journey = await Journey.findOne({ userId: req.user.userId, status: 'active' });
    if (!journey) throw new ApiError(404, 'No active journey');

    const idx = journey.milestones.findIndex(m => m._id.toString() === milestoneId);
    if (idx === -1) throw new ApiError(404, 'Milestone not found');

    journey.milestones.splice(idx, 1);
    journey.progress.milestonesTotal = journey.milestones.length;
    await journey.save();

    res.json(apiResponse.success(journey.milestones, 'Milestone deleted'));
  } catch (err) { next(err); }
};

module.exports = { getActiveJourney, generateJourney, getTodayPlan, getWeekPlan, pauseJourney, resumeJourney, getMilestones, addMilestone, deleteMilestone, getProgress, getAdaptations, completeAssignment, getDashboard };
