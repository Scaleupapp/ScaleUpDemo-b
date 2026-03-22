const UserObjective = require('../models/UserObjective');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const Journey = require('../models/Journey');
const Quiz = require('../models/Quiz');
const ContentProgress = require('../models/ContentProgress');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const { ensureStreakFresh } = require('./streakService');
const journeyProgressService = require('./journeyProgressService');

class DashboardService {

  async getDashboard(userId, objectiveId = null) {
    // Ensure streak is fresh before reading it
    await ensureStreakFresh(userId);

    let journeyQuery = { userId, status: { $in: ['active', 'paused'] } };
    if (objectiveId) {
      journeyQuery.objectiveId = objectiveId;
    }

    const [objectives, profile, journey, pendingQuizzes, graph] = await Promise.all([
      UserObjective.find({ userId, status: 'active' }).sort({ isPrimary: -1 }),
      KnowledgeProfile.findOne({ userId }),
      Journey.findOne(journeyQuery).sort({ status: 1 }), // 'active' sorts before 'paused'
      Quiz.countDocuments({ userId, status: { $in: ['ready', 'delivered'] }, expiresAt: { $gt: new Date() } }),
      ConsumptionGraph.findOne({ userId }),
    ]);

    // Sync journey progress with actual content consumption
    if (journey) {
      await journeyProgressService.syncProgress(journey, userId);
    }

    // Weekly stats (last 7 days) + previous week for growth comparison
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const [weeklyContentConsumed, prevWeekContentConsumed] = await Promise.all([
      ContentProgress.countDocuments({
        userId, isCompleted: true, completedAt: { $gte: oneWeekAgo },
      }),
      ContentProgress.countDocuments({
        userId, isCompleted: true, completedAt: { $gte: twoWeeksAgo, $lt: oneWeekAgo },
      }),
    ]);

    // Readiness score: knowledge 40% + journey 30% + consistency 30%
    const knowledgeScore = profile?.overallScore || 0;
    const journeyScore = journey ? Math.round(journey.progress.overallPercentage) : 0;
    const consistencyScore = journey ? Math.min(100, journey.progress.currentStreak * 14) : 0;
    const readinessScore = Math.round(knowledgeScore * 0.4 + journeyScore * 0.3 + consistencyScore * 0.3);

    // Today's plan
    let todayPlan = null;
    if (journey) {
      const currentWeekPlan = journey.weeklyPlans.find(w => w.weekNumber === journey.currentWeek);
      const dayOfWeek = new Date().getDay() || 7;
      todayPlan = currentWeekPlan?.dailyAssignments.find(d => d.day === dayOfWeek);
    }

    // Next actions
    const nextActions = [];
    if (todayPlan && !todayPlan.completed) {
      nextActions.push({ type: 'content', message: 'Complete today\'s assigned content', data: todayPlan });
    }
    if (pendingQuizzes > 0) {
      nextActions.push({ type: 'quiz', message: `You have ${pendingQuizzes} quiz(es) waiting`, count: pendingQuizzes });
    }

    // Upcoming milestones
    const upcomingMilestones = journey?.milestones
      .filter(m => m.status === 'upcoming' || m.status === 'in_progress')
      .slice(0, 3) || [];

    // Weekly growth: content delta and knowledge score delta
    const weeklyGrowth = {
      contentDelta: weeklyContentConsumed - prevWeekContentConsumed,
      contentThisWeek: weeklyContentConsumed,
      contentLastWeek: prevWeekContentConsumed,
    };

    // Recent achievements: milestones achieved in last 14 days
    const recentAchievements = (journey?.milestones || [])
      .filter(m => m.status === 'achieved' && m.achievedAt && new Date(m.achievedAt) >= twoWeeksAgo)
      .sort((a, b) => new Date(b.achievedAt) - new Date(a.achievedAt))
      .slice(0, 5)
      .map(m => ({ title: m.title, type: m.type, achievedAt: m.achievedAt }));

    return {
      objectives: objectives.map(o => ({
        _id: o._id, objectiveType: o.objectiveType, specifics: o.specifics,
        isPrimary: o.isPrimary, weight: o.weight, timeline: o.timeline, targetDate: o.targetDate,
      })),
      readinessScore,
      knowledgeProfile: profile ? {
        overallScore: profile.overallScore,
        totalTopicsCovered: profile.totalTopicsCovered,
        totalQuizzesTaken: profile.totalQuizzesTaken,
        strengths: profile.strengths.slice(0, 5),
        weaknesses: profile.weaknesses.slice(0, 5),
        topicMastery: profile.topicMastery.map(t => ({
          topic: t.topic, score: t.score, level: t.level, trend: t.trend,
        })),
      } : null,
      journey: journey ? {
        title: journey.title,
        currentPhase: journey.phases[journey.currentPhaseIndex]?.name,
        currentWeek: journey.currentWeek,
        progress: journey.progress,
        streak: journey.progress.currentStreak,
      } : null,
      weeklyStats: {
        contentConsumed: weeklyContentConsumed,
        totalContentConsumed: graph?.totalContentConsumed || 0,
        dominantTopics: graph?.dominantTopics || [],
      },
      nextActions,
      upcomingMilestones,
      pendingQuizzes,
      weeklyGrowth,
      recentAchievements,
    };
  }
}

module.exports = new DashboardService();
