/**
 * v2 "You" Tab Overview route.
 *
 *   GET /api/v2/you/overview
 *
 * Aggregates everything the v2 "You" screen needs in one network call:
 *   - user profile (name, avatar, initial)
 *   - readiness score for primary objective
 *   - target date + weeks remaining
 *   - week progress (3 of 7 done)
 *   - streak (quiet stat)
 *   - top gap (one topic name + CTA)
 *   - time invested
 *   - role flags (isCreator, isAdmin)
 */
const express = require('express');
const auth = require('../../middleware/auth');
const User = require('../../models/User');
const UserObjective = require('../../models/UserObjective');
const Plan = require('../../models/Plan');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const CompetitionProfile = require('../../models/CompetitionProfile');
const Journey = require('../../models/Journey');
const QuizAttempt = require('../../models/QuizAttempt');
const ContentProgress = require('../../models/ContentProgress');
const InterviewSession = require('../../models/InterviewSession');
const CognitiveProfile = require('../../models/CognitiveProfile');
const CompassConversation = require('../../models/CompassConversation');

const router = express.Router();

router.get('/overview', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [user, objective, plan, journey, knowledge, competition] = await Promise.all([
      User.findById(userId).select('firstName lastName profilePicture role').lean(),
      UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
      Plan.findOne({ userId, status: { $in: ['active', 'ready'] } }).lean(),
      Journey.findOne({ userId, status: 'active' }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
      CompetitionProfile.findOne({ userId }).lean(),
    ]);

    // Readiness
    const readiness =
      plan?.readinessScore ??
      journey?.readinessScore ??
      computeReadinessFromKnowledge(knowledge) ??
      0;

    // Target date and weeks remaining
    let targetDateStr = null;
    let weeksRemaining = null;
    if (objective?.targetDate) {
      const target = new Date(objective.targetDate);
      const now = new Date();
      const days = Math.max(0, Math.ceil((target - now) / (1000 * 60 * 60 * 24)));
      weeksRemaining = Math.ceil(days / 7);
      targetDateStr = target.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    }

    // Week progress
    const currentWeek = plan?.currentWeek || journey?.currentWeek || 1;
    const tasksThisWeek = (plan?.tasks || []).filter(t => t.weekNumber === currentWeek);
    const weekDone = tasksThisWeek.filter(t => t.completedAt).length;
    const weekTotal = tasksThisWeek.length;

    // Top gap
    const topGap = pickTopGap(knowledge);

    // Time invested (best-effort — sum of plan.tasks.completedAt durations)
    const hoursInvested = Math.round((plan?.tasks || []).reduce((sum, t) => {
      if (!t.completedAt) return sum;
      return sum + (t.actualDurationMin || t.durationMin || t.estimatedMinutes || 0);
    }, 0) / 60);

    const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();

    return res.json({
      success: true,
      data: {
        user: {
          name: fullName || 'Learner',
          firstName: user?.firstName || 'Learner',
          initial: (user?.firstName?.[0] || 'L').toUpperCase(),
          avatarURL: user?.profilePicture || null,
          role: user?.role || 'consumer',
        },
        readiness: {
          score: readiness,
          onTrackText: readiness >= 70 ? `On track for ${targetDateStr || 'your target'}` : `${readiness}% ready`,
          targetDate: targetDateStr,
          weeksRemaining,
        },
        weekProgress: weekTotal > 0
          ? { done: weekDone, total: weekTotal, week: currentWeek }
          : null,
        streak: {
          current: competition?.currentStreak || 0,
          longest: competition?.longestStreak || 0,
        },
        topGap: topGap ? {
          topic: topGap.topic,
          masteryPct: topGap.mastery,
          ctaLabel: 'Fix this',
        } : null,
        timeInvested: { hours: hoursInvested },
        flags: {
          isCreator: ['creator', 'contributor', 'admin'].includes(user?.role),
          isAdmin: user?.role === 'admin',
        },
        objectiveLabel: buildObjectiveLabel(objective),
      },
    });
  } catch (err) {
    console.error('[v2/you/overview] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load overview' });
  }
});

function computeReadinessFromKnowledge(knowledge) {
  if (!knowledge?.topicProfiles) return null;
  const entries = Object.values(knowledge.topicProfiles || {});
  if (entries.length === 0) return null;
  const avg = entries.reduce((s, t) => s + (t.masteryLevel || 0), 0) / entries.length;
  return Math.round(avg);
}

function pickTopGap(knowledge) {
  if (!knowledge?.topicProfiles) return null;
  const entries = Object.entries(knowledge.topicProfiles || {})
    .map(([topic, t]) => ({ topic, mastery: t.masteryLevel || 0 }))
    .filter(t => t.mastery < 70)
    .sort((a, b) => a.mastery - b.mastery);
  return entries[0] || null;
}

function buildObjectiveLabel(obj) {
  if (!obj) return null;
  const s = obj.specifics || {};
  const parts = [];
  if (s.targetRole) parts.push(s.targetRole);
  if (s.targetCompany) parts.push(`@ ${s.targetCompany}`);
  if (s.examName) parts.push(s.examName);
  if (s.targetSkill && parts.length === 0) parts.push(s.targetSkill);

  const timelineLabel = {
    '1_month': '1mo', '3_months': '3mo', '6_months': '6mo',
    '1_year': '12mo', 'no_deadline': '',
  }[obj.timeline] || '';

  const base = parts.join(' ') || obj.objectiveType.replace(/_/g, ' ');
  return timelineLabel ? `${base} · ${timelineLabel}` : base;
}

/**
 * GET /api/v2/you/analytics
 *
 * The deep "You" payload — everything the user has done so far. Powers the
 * comprehensive You tab: lifetime counts, quiz performance trend, learning
 * velocity, cognitive fingerprint, mastery map, recent activity feed, and
 * achievements. Kept separate from /overview so the header stays a fast,
 * small call and the heavy aggregation only runs when the tab is opened.
 */
router.get('/analytics', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [
      user, objective, knowledge, cognitive, competition,
      quizAttempts, contentProgress, interviews,
      contentCount, conversationCount,
    ] = await Promise.all([
      User.findById(userId).select('firstName lastName profilePicture role email createdAt').lean(),
      UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
      CognitiveProfile.findOne({ userId }).lean(),
      CompetitionProfile.findOne({ userId }).lean(),
      QuizAttempt.find({ userId, status: 'completed' })
        .select('score topicBreakdown completedAt totalTime quizId')
        .sort({ completedAt: -1 }).limit(50).lean(),
      ContentProgress.find({ userId })
        .select('isCompleted completedAt totalTimeSpent percentageCompleted lastSessionAt contentId')
        .sort({ lastSessionAt: -1 }).limit(50).lean(),
      InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] } })
        .select('interviewType targetRole evaluation.overallScore completedAt duration')
        .sort({ completedAt: -1 }).limit(20).lean(),
      ContentProgress.countDocuments({ userId, isCompleted: true }),
      CompassConversation.countDocuments({ userId, isArchived: { $ne: true } }),
    ]);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const completedQuizzes = quizAttempts.filter(q => q.completedAt);
    const completedInterviews = interviews.filter(i => i.completedAt);

    // --- Lifetime counts ---
    const counts = {
      quizzesTaken: completedQuizzes.length,
      contentCompleted: contentCount,
      interviewsTaken: completedInterviews.length,
      compassConversations: conversationCount,
      topicsCovered: (knowledge?.topicMastery || []).length,
    };

    // --- Quiz performance trend (oldest → newest, last 20) ---
    const quizTrendSrc = completedQuizzes.slice(0, 20).reverse();
    const quizTrend = quizTrendSrc.map(q => ({
      date: q.completedAt,
      score: Math.round(q.score?.percentage || 0),
    }));
    const avgQuizScore = completedQuizzes.length
      ? Math.round(completedQuizzes.reduce((s, q) => s + (q.score?.percentage || 0), 0) / completedQuizzes.length)
      : null;
    // Recent vs prior split to surface a direction-of-travel signal.
    let quizDirection = 'stable';
    if (completedQuizzes.length >= 6) {
      const recent = completedQuizzes.slice(0, 3);
      const prior = completedQuizzes.slice(3, 6);
      const avg = arr => arr.reduce((s, q) => s + (q.score?.percentage || 0), 0) / arr.length;
      const delta = avg(recent) - avg(prior);
      quizDirection = delta > 5 ? 'improving' : delta < -5 ? 'declining' : 'stable';
    }

    // --- Time invested (minutes) across content + interviews ---
    const contentMinutes = Math.round(
      contentProgress.reduce((s, c) => s + (c.totalTimeSpent || 0), 0) / 60
    );
    const interviewMinutes = Math.round(
      completedInterviews.reduce((s, i) => s + (i.duration || 0), 0) / 60
    );
    const timeInvested = {
      totalMinutes: contentMinutes + interviewMinutes,
      contentMinutes,
      interviewMinutes,
    };

    // --- Mastery map (per-topic, primary objective first) ---
    const masteryMap = (knowledge?.topicMastery || [])
      .map(t => ({
        topic: t.topic,
        score: Math.round(t.score || 0),
        level: t.level || 'not_started',
        trend: t.trend || 'stable',
        quizzesTaken: t.quizzesTaken || 0,
        lastAssessedAt: t.lastAssessedAt || null,
      }))
      .sort((a, b) => b.score - a.score);

    // --- Learning velocity ---
    const velocity = {
      topicsPerWeek: knowledge?.learningVelocity?.topicsPerWeek || 0,
      avgScoreImprovement: knowledge?.learningVelocity?.averageScoreImprovement || 0,
      overallScore: Math.round(knowledge?.overallScore || 0),
    };

    // --- Cognitive fingerprint (only surface confident inferences) ---
    const cog = {};
    if (cognitive?.timeOfDay?.confidence >= 0.6) {
      cog.bestTime = {
        block: cognitive.timeOfDay.bestHourBlock,
        hour: cognitive.timeOfDay.bestHour,
        scoreLift: Math.round(cognitive.timeOfDay.bestHourScoreLift || 0),
      };
    }
    if (cognitive?.modality?.confidence >= 0.6 && cognitive.modality.preferred) {
      cog.preferredFormat = cognitive.modality.preferred;
    }
    if (cognitive?.sessionRhythm?.confidence >= 0.6 && cognitive.sessionRhythm.style) {
      cog.sessionStyle = {
        style: cognitive.sessionRhythm.style,
        medianMinutes: Math.round(cognitive.sessionRhythm.medianSessionMinutes || 0),
      };
    }
    if (knowledge?.behavioralProfile?.type) {
      cog.learnerType = knowledge.behavioralProfile.type;
    }

    // --- Recent activity feed (merged, newest first) ---
    const activity = [];
    for (const q of completedQuizzes.slice(0, 15)) {
      activity.push({
        type: 'quiz',
        at: q.completedAt,
        title: 'Quiz completed',
        detail: `${Math.round(q.score?.percentage || 0)}%`,
      });
    }
    for (const c of contentProgress.filter(c => c.isCompleted).slice(0, 15)) {
      activity.push({
        type: 'content',
        at: c.completedAt || c.lastSessionAt,
        title: 'Content completed',
        detail: null,
      });
    }
    for (const i of completedInterviews.slice(0, 10)) {
      activity.push({
        type: 'interview',
        at: i.completedAt,
        title: `${(i.interviewType || 'interview').replace(/_/g, ' ')}`,
        detail: i.evaluation?.overallScore != null ? `${Math.round(i.evaluation.overallScore)}/100` : null,
      });
    }
    activity.sort((a, b) => new Date(b.at) - new Date(a.at));
    const recentActivity = activity.filter(a => a.at).slice(0, 20);

    // --- Achievements (derived, no separate collection) ---
    const achievements = [];
    if (counts.quizzesTaken >= 1) achievements.push({ id: 'first_quiz', label: 'First quiz', earned: true });
    if (counts.quizzesTaken >= 10) achievements.push({ id: 'quiz_10', label: '10 quizzes', earned: true });
    if (counts.quizzesTaken >= 50) achievements.push({ id: 'quiz_50', label: '50 quizzes', earned: true });
    if (counts.contentCompleted >= 10) achievements.push({ id: 'content_10', label: '10 lessons', earned: true });
    if (counts.interviewsTaken >= 1) achievements.push({ id: 'first_interview', label: 'First mock interview', earned: true });
    if ((competition?.longestStreak || 0) >= 7) achievements.push({ id: 'streak_7', label: '7-day streak', earned: true });
    if ((competition?.longestStreak || 0) >= 30) achievements.push({ id: 'streak_30', label: '30-day streak', earned: true });
    if (avgQuizScore != null && avgQuizScore >= 80 && counts.quizzesTaken >= 5) {
      achievements.push({ id: 'sharp_shooter', label: '80%+ average', earned: true });
    }

    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();

    return res.json({
      success: true,
      data: {
        user: {
          name: fullName || 'Learner',
          firstName: user.firstName || 'Learner',
          initial: (user.firstName?.[0] || 'L').toUpperCase(),
          avatarURL: user.profilePicture || null,
          email: user.email || null,
          role: user.role || 'consumer',
          memberSince: user.createdAt || null,
        },
        objectiveLabel: buildObjectiveLabel(objective),
        counts,
        quizPerformance: {
          trend: quizTrend,
          averageScore: avgQuizScore,
          direction: quizDirection,
        },
        timeInvested,
        velocity,
        masteryMap,
        strengths: knowledge?.strengths || [],
        weaknesses: knowledge?.weaknesses || [],
        cognitive: cog,
        streak: {
          current: competition?.currentStreak || 0,
          longest: competition?.longestStreak || 0,
        },
        recentActivity,
        achievements,
      },
    });
  } catch (err) {
    console.error('[v2/you/analytics] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load analytics' });
  }
});

module.exports = router;
