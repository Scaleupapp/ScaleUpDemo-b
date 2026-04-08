const apiResponse = require('../utils/apiResponse');
const UserObjective = require('../models/UserObjective');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const Journey = require('../models/Journey');
const Quiz = require('../models/Quiz');
const DailyChallenge = require('../models/DailyChallenge');
const ChallengeAttempt = require('../models/ChallengeAttempt');
const Content = require('../models/Content');
const ContentProgress = require('../models/ContentProgress');
const { ensureStreakFresh } = require('../services/streakService');
const journeyProgressService = require('../services/journeyProgressService');
const recommendationService = require('../services/recommendationService');

/**
 * GET /api/v1/today/summary
 *
 * Returns everything the Today tab needs in one call:
 * - User's objective with skills
 * - Today's journey content (day number, lessons)
 * - Available quizzes (count + list)
 * - Today's challenges (with user completion status)
 * - Recommended content (objective-matched)
 * - Readiness score + streak + pace
 */
const getSummary = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    // Ensure streak is fresh (non-blocking)
    try { await ensureStreakFresh(userId); } catch (e) { /* non-fatal */ }

    // ── Parallel fetch everything ──
    const [
      objectives,
      knowledgeProfile,
      journey,
      pendingQuizzes,
      todayChallenges,
    ] = await Promise.all([
      UserObjective.find({ userId, status: 'active' }).sort({ isPrimary: -1 }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
      Journey.findOne({ userId, status: { $in: ['active', 'paused'] } }).sort({ status: 1 }).lean(),
      Quiz.find({
        userId,
        status: { $in: ['ready', 'delivered'] },
        expiresAt: { $gt: new Date() }
      }).select('topic totalQuestions type status triggerContext expiresAt').lean(),
      _getTodayChallengesWithStatus(userId),
    ]);

    // ── Primary objective ──
    const primaryObjective = objectives.find(o => o.isPrimary) || objectives[0] || null;
    const objectiveId = primaryObjective?._id?.toString();

    // ── Skills derived from objective ──
    const skills = _deriveSkills(primaryObjective);

    // ── Journey today data ──
    let todayPlan = null;
    let dayNumber = 1;
    let totalDays = 1;
    let journeyContentItems = [];

    if (journey) {
      // Sync progress (non-blocking)
      try { await journeyProgressService.syncProgress(journey, userId); } catch (e) { /* non-fatal */ }

      const currentWeek = journey.currentWeek || 1;
      const weekPlan = journey.weeklyPlans?.find(w => w.weekNumber === currentWeek);
      const todayDOW = new Date().getDay(); // 0=Sun ... 6=Sat
      const dayIndex = todayDOW === 0 ? 6 : todayDOW - 1; // Mon=0 ... Sun=6
      const dailyPlan = weekPlan?.dailyPlans?.[dayIndex];

      dayNumber = ((currentWeek - 1) * 7) + dayIndex + 1;
      totalDays = (journey.totalWeeks || 12) * 7;

      if (dailyPlan?.contentIds?.length) {
        // Fetch content items with progress
        const contentItems = await Content.find({
          _id: { $in: dailyPlan.contentIds },
          status: 'published'
        }).select('title contentType domain topics difficulty duration thumbnailURL creatorId sourceType viewCount').lean();

        const progressMap = {};
        const progresses = await ContentProgress.find({
          userId,
          contentId: { $in: dailyPlan.contentIds }
        }).lean();
        progresses.forEach(p => { progressMap[p.contentId.toString()] = p; });

        journeyContentItems = contentItems.map(c => ({
          ...c,
          _progress: progressMap[c._id.toString()] ? {
            status: progressMap[c._id.toString()].status || 'not_started',
            progressPercentage: progressMap[c._id.toString()].progressPercentage || 0,
          } : { status: 'not_started', progressPercentage: 0 }
        }));
      }

      todayPlan = {
        weekNumber: currentWeek,
        dayIndex,
        goals: weekPlan?.goals || dailyPlan?.goals || [],
        topics: dailyPlan?.topics || weekPlan?.topics || [],
        contentItems: journeyContentItems,
        todayStats: {
          totalItems: journeyContentItems.length,
          completedItems: journeyContentItems.filter(c => c._progress?.status === 'completed').length,
          inProgressItems: journeyContentItems.filter(c => c._progress?.status === 'in_progress').length,
        }
      };
    }

    // ── Recommendations (objective-matched + general) ──
    let recommendedContent = [];
    try {
      if (objectiveId) {
        const objRecs = await recommendationService.getObjectiveRecommendations(userId, objectiveId, { limit: 8 });
        recommendedContent = objRecs.items || [];
      }
      if (recommendedContent.length < 5) {
        const feed = await recommendationService.getPersonalizedFeed(userId, { page: 1, limit: 8 });
        const existingIds = new Set(recommendedContent.map(c => c._id.toString()));
        const additional = (feed.items || []).filter(c => !existingIds.has(c._id.toString()));
        recommendedContent = [...recommendedContent, ...additional].slice(0, 10);
      }
    } catch (e) { /* non-fatal */ }

    // ── Readiness score ──
    const overallScore = knowledgeProfile?.overallScore || 0;
    const journeyProgress = journey?.progress?.overallPercentage || 0;
    const streak = journey?.progress?.currentStreak || 0;
    const longestStreak = journey?.progress?.longestStreak || 0;
    const consistencyScore = Math.min(100, streak * 10);
    const readinessScore = Math.round(
      (overallScore * 0.4) + (journeyProgress * 0.3) + (consistencyScore * 0.3)
    );

    // ── Pace ──
    let pace = 'just_started';
    if (journey) {
      const expectedProgress = (dayNumber / totalDays) * 100;
      if (journeyProgress >= expectedProgress + 10) pace = 'ahead';
      else if (journeyProgress >= expectedProgress - 5) pace = 'on_track';
      else pace = 'behind';
    }

    // ── Build response ──
    const summary = {
      // Objective
      objective: primaryObjective ? {
        id: primaryObjective._id,
        objectiveType: primaryObjective.objectiveType,
        specifics: primaryObjective.specifics,
        timeline: primaryObjective.timeline,
        targetDate: primaryObjective.targetDate,
        currentLevel: primaryObjective.currentLevel,
      } : null,
      skills,

      // Journey
      dayNumber,
      hasJourney: !!journey,
      todayPlan,

      // Practice
      quizzes: {
        count: pendingQuizzes.length,
        items: pendingQuizzes,
      },
      challenges: {
        count: todayChallenges.length,
        items: todayChallenges,
        totalPlaying: todayChallenges.reduce((sum, c) => sum + (c.participantCount || 0), 0),
      },

      // Content
      recommendedContent,

      // Progress
      readinessScore,
      streak,
      longestStreak,
      pace,
      daysRemaining: primaryObjective?.targetDate
        ? Math.max(0, Math.ceil((new Date(primaryObjective.targetDate) - new Date()) / (1000 * 60 * 60 * 24)))
        : null,
    };

    res.json(apiResponse.success(summary, 'Today summary loaded'));
  } catch (err) {
    console.error('📅 TODAY SUMMARY ERROR:', err);
    next(err);
  }
};

/**
 * Get today's challenges with user completion status
 */
async function _getTodayChallengesWithStatus(userId) {
  const today = _todayIST();
  const challenges = await DailyChallenge.find({ date: today, status: 'active' })
    .select('-questions.correctAnswer -questions.explanation')
    .lean();

  if (!challenges.length) return [];

  const challengeIds = challenges.map(c => c._id);
  const attempts = await ChallengeAttempt.find({
    userId,
    challengeId: { $in: challengeIds },
    status: 'completed'
  }).lean();

  const attemptMap = {};
  attempts.forEach(a => { attemptMap[a.challengeId.toString()] = a; });

  return challenges.map(c => ({
    ...c,
    userCompleted: !!attemptMap[c._id.toString()],
    userScore: attemptMap[c._id.toString()]?.score || null,
  }));
}

/**
 * Derive skills from objective type + specifics
 */
function _deriveSkills(objective) {
  if (!objective) return [];

  // Use topicsOfInterest if available
  if (objective.topicsOfInterest?.length) {
    return objective.topicsOfInterest.map(t => ({
      name: t,
      source: 'objective',
    }));
  }

  // Otherwise derive from objective type
  const type = objective.objectiveType;
  const role = objective.specifics?.targetRole?.toLowerCase() || '';
  const skill = objective.specifics?.targetSkill?.toLowerCase() || '';

  if (type === 'interview_preparation') {
    if (role.includes('product')) {
      return ['Product Strategy', 'User Research', 'Metrics & Analytics', 'Roadmapping', 'Stakeholder Management']
        .map(s => ({ name: s, source: 'derived' }));
    }
    if (role.includes('engineer') || role.includes('developer')) {
      return ['System Design', 'Data Structures', 'Algorithms', 'API Design', 'Problem Solving']
        .map(s => ({ name: s, source: 'derived' }));
    }
    if (role.includes('data')) {
      return ['SQL', 'Statistics', 'Machine Learning', 'Data Visualization', 'Python']
        .map(s => ({ name: s, source: 'derived' }));
    }
    return ['Communication', 'Problem Solving', 'Technical Skills', 'Behavioral Questions', 'System Design']
      .map(s => ({ name: s, source: 'derived' }));
  }

  if (type === 'upskilling') {
    return [skill || 'Target Skill', 'Foundations', 'Advanced Concepts', 'Practice', 'Projects']
      .map(s => ({ name: s, source: 'derived' }));
  }

  if (type === 'exam_preparation') {
    return ['Concepts', 'Problem Solving', 'Time Management', 'Practice Tests', 'Revision']
      .map(s => ({ name: s, source: 'derived' }));
  }

  return ['Learning', 'Practice', 'Assessment', 'Review']
    .map(s => ({ name: s, source: 'derived' }));
}

/**
 * Get today's date in IST (YYYY-MM-DD)
 */
function _todayIST() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  return ist.toISOString().split('T')[0];
}

module.exports = { getSummary };
