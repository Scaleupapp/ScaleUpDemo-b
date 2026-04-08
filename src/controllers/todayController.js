const apiResponse = require('../utils/apiResponse');
const aiProvider = require('../config/aiProvider');
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

// ─────────────────────────────────────────────────────────────
// GET /api/v1/today/summary
// ─────────────────────────────────────────────────────────────

const getSummary = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    try { await ensureStreakFresh(userId); } catch (e) { /* non-fatal */ }

    const [objectives, knowledgeProfile, journey, pendingQuizzes, todayChallenges] = await Promise.all([
      UserObjective.find({ userId, status: 'active' }).sort({ isPrimary: -1 }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
      Journey.findOne({ userId, status: { $in: ['active', 'paused'] } }).sort({ status: 1 }).lean(),
      Quiz.find({ userId, status: { $in: ['ready', 'delivered'] }, expiresAt: { $gt: new Date() } })
        .select('title topic totalQuestions type status triggerContext expiresAt questions').lean(),
      _getTodayChallengesWithStatus(userId),
    ]);

    const primaryObjective = objectives.find(o => o.isPrimary) || objectives[0] || null;
    const objectiveId = primaryObjective?._id?.toString();
    const skills = _deriveSkills(primaryObjective);

    // Journey today
    let todayPlan = null;
    let dayNumber = 1;
    let totalDays = 1;
    let journeyContentItems = [];

    if (journey) {
      try { await journeyProgressService.syncProgress(journey, userId); } catch (e) {}
      const currentWeek = journey.currentWeek || 1;
      const weekPlan = journey.weeklyPlans?.find(w => w.weekNumber === currentWeek);
      const todayDOW = new Date().getDay();
      const dayIndex = todayDOW === 0 ? 6 : todayDOW - 1;
      dayNumber = ((currentWeek - 1) * 7) + dayIndex + 1;
      totalDays = (journey.totalWeeks || 12) * 7;

      if (weekPlan?.dailyPlans?.[dayIndex]?.contentIds?.length) {
        const contentItems = await Content.find({
          _id: { $in: weekPlan.dailyPlans[dayIndex].contentIds }, status: 'published'
        }).select('title contentType domain topics difficulty duration thumbnailURL creatorId sourceType viewCount').lean();
        const progresses = await ContentProgress.find({ userId, contentId: { $in: weekPlan.dailyPlans[dayIndex].contentIds } }).lean();
        const progressMap = {};
        progresses.forEach(p => { progressMap[p.contentId.toString()] = p; });
        journeyContentItems = contentItems.map(c => ({
          ...c,
          _progress: progressMap[c._id.toString()]
            ? { status: progressMap[c._id.toString()].status || 'not_started', progressPercentage: progressMap[c._id.toString()].progressPercentage || 0 }
            : { status: 'not_started', progressPercentage: 0 }
        }));
      }

      todayPlan = {
        weekNumber: currentWeek, dayIndex,
        goals: weekPlan?.goals || [],
        topics: weekPlan?.dailyPlans?.[dayIndex]?.topics || weekPlan?.topics || [],
        contentItems: journeyContentItems,
        todayStats: {
          totalItems: journeyContentItems.length,
          completedItems: journeyContentItems.filter(c => c._progress?.status === 'completed').length,
          inProgressItems: journeyContentItems.filter(c => c._progress?.status === 'in_progress').length,
        }
      };
    }

    // Recommendations
    let recommendedContent = [];
    try {
      if (objectiveId) {
        const objRecs = await recommendationService.getObjectiveRecommendations(userId, objectiveId, { limit: 8 });
        recommendedContent = objRecs.items || [];
      }
      if (recommendedContent.length < 5) {
        const feed = await recommendationService.getPersonalizedFeed(userId, { page: 1, limit: 8 });
        const existingIds = new Set(recommendedContent.map(c => c._id.toString()));
        recommendedContent = [...recommendedContent, ...(feed.items || []).filter(c => !existingIds.has(c._id.toString()))].slice(0, 10);
      }
    } catch (e) {}

    // Readiness
    const overallScore = knowledgeProfile?.overallScore || 0;
    const journeyProgress = journey?.progress?.overallPercentage || 0;
    const streak = journey?.progress?.currentStreak || 0;
    const consistencyScore = Math.min(100, streak * 10);
    const readinessScore = Math.round((overallScore * 0.4) + (journeyProgress * 0.3) + (consistencyScore * 0.3));

    let pace = 'just_started';
    if (journey) {
      const expected = (dayNumber / totalDays) * 100;
      if (journeyProgress >= expected + 10) pace = 'ahead';
      else if (journeyProgress >= expected - 5) pace = 'on_track';
      else pace = 'behind';
    }

    res.json(apiResponse.success({
      objective: primaryObjective ? {
        id: primaryObjective._id, objectiveType: primaryObjective.objectiveType,
        specifics: primaryObjective.specifics, timeline: primaryObjective.timeline,
        targetDate: primaryObjective.targetDate, currentLevel: primaryObjective.currentLevel,
      } : null,
      skills, dayNumber, hasJourney: !!journey, todayPlan,
      quizzes: { count: pendingQuizzes.length, items: pendingQuizzes },
      challenges: { count: todayChallenges.length, items: todayChallenges, totalPlaying: todayChallenges.reduce((s, c) => s + (c.participantCount || 0), 0) },
      recommendedContent, readinessScore, streak,
      longestStreak: journey?.progress?.longestStreak || 0,
      pace, daysRemaining: primaryObjective?.targetDate ? Math.max(0, Math.ceil((new Date(primaryObjective.targetDate) - new Date()) / 86400000)) : null,
    }, 'Today summary loaded'));
  } catch (err) {
    console.error('📅 TODAY SUMMARY ERROR:', err);
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/v1/today/intent
// ─────────────────────────────────────────────────────────────

const processIntent = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json(apiResponse.error('Message is required'));
    }

    // Get user context
    const [objectives, knowledgeProfile] = await Promise.all([
      UserObjective.find({ userId, status: 'active' }).sort({ isPrimary: -1 }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
    ]);

    const primaryObjective = objectives[0];
    const skills = _deriveSkills(primaryObjective);
    const goalTitle = primaryObjective?.specifics?.targetRole
      || primaryObjective?.specifics?.targetSkill
      || primaryObjective?.specifics?.examName
      || primaryObjective?.objectiveType?.replace(/_/g, ' ') || 'learning';

    // ── Call Claude to parse intent ──
    const intentResult = await aiProvider.analyzeWithClaude({
      systemPrompt: `You are a learning coach assistant for ScaleUp, an AI-powered career learning platform.
Parse the user's message into a structured intent. The user's goal is: "${goalTitle}".
Their skills are: ${skills.map(s => s.name).join(', ')}.
Their knowledge level: ${primaryObjective?.currentLevel || 'intermediate'}.

Return ONLY a JSON object with:
{
  "intent": "learn" | "practice" | "progress" | "interview" | "create_content" | "general",
  "topic": "specific topic if mentioned, or null",
  "response": "A warm, brief coaching message (1-2 sentences) acknowledging their intent and encouraging them. Be specific to their goal.",
  "filter": "any content filter like 'video', 'notes', 'article' or null",
  "action_label": "label for the primary action button, e.g. 'Show videos on Roadmapping' or 'Start Product Strategy quiz'"
}

Intent mapping:
- "learn" = wants to see content, videos, lessons, study material, learn about a topic
- "practice" = wants quiz, test, assessment, compete, challenge, evaluate skills
- "progress" = wants to see their score, readiness, analytics, how they're doing, next steps
- "interview" = wants mock interview, interview prep, practice interview
- "create_content" = wants to create or upload content (for creators)
- "general" = greeting, unclear intent, or doesn't match above`,
      userPrompt: message.trim(),
      temperature: 0.2,
      maxTokens: 500,
    });

    const intent = intentResult.intent || 'general';
    const topic = intentResult.topic || null;
    const coachMessage = intentResult.response || "Let me help you with that.";
    const filter = intentResult.filter || null;
    const actionLabel = intentResult.action_label || null;

    // ── Fetch data based on intent ──
    let data = {};

    if (intent === 'learn') {
      // Get content — filtered by topic if specified
      let content = [];
      try {
        if (topic) {
          content = await Content.find({
            status: 'published',
            $or: [
              { domain: { $regex: topic, $options: 'i' } },
              { topics: { $elemMatch: { $regex: topic, $options: 'i' } } },
              { title: { $regex: topic, $options: 'i' } },
            ]
          })
          .select('title contentType domain topics difficulty duration thumbnailURL creatorId sourceType viewCount averageRating')
          .sort({ viewCount: -1 })
          .limit(10)
          .lean();
        }
        // If no topic match or no topic, use recommendations
        if (!content.length) {
          const objectiveId = primaryObjective?._id?.toString();
          if (objectiveId) {
            const recs = await recommendationService.getObjectiveRecommendations(userId, objectiveId, { limit: 10 });
            content = recs.items || [];
          }
          if (!content.length) {
            const feed = await recommendationService.getPersonalizedFeed(userId, { page: 1, limit: 10 });
            content = feed.items || [];
          }
        }
        // Apply type filter if specified
        if (filter && content.length) {
          const typeFilter = filter.toLowerCase();
          const filtered = content.filter(c => c.contentType === typeFilter);
          if (filtered.length) content = filtered;
        }
      } catch (e) { console.error('Intent content fetch error:', e.message); }

      // Enrich with progress
      if (content.length) {
        const progresses = await ContentProgress.find({ userId, contentId: { $in: content.map(c => c._id) } }).lean();
        const progressMap = {};
        progresses.forEach(p => { progressMap[p.contentId.toString()] = p; });
        content = content.map(c => ({
          ...c,
          _progress: progressMap[c._id.toString()]
            ? { status: progressMap[c._id.toString()].status, progressPercentage: progressMap[c._id.toString()].progressPercentage || 0 }
            : null
        }));
      }

      data.content = content;

    } else if (intent === 'practice') {
      const quizzes = await Quiz.find({
        userId, status: { $in: ['ready', 'delivered'] }, expiresAt: { $gt: new Date() }
      }).select('topic totalQuestions type status triggerContext expiresAt').lean();

      // Filter by topic if specified
      let filteredQuizzes = quizzes;
      if (topic) {
        const topicLower = topic.toLowerCase();
        filteredQuizzes = quizzes.filter(q => q.topic.toLowerCase().includes(topicLower));
        if (!filteredQuizzes.length) filteredQuizzes = quizzes; // fallback to all
      }

      const challenges = await _getTodayChallengesWithStatus(userId);

      data.quizzes = filteredQuizzes;
      data.challenges = challenges;
      data.canGenerateQuiz = true;
      data.suggestedQuizTopic = topic || goalTitle;

    } else if (intent === 'progress') {
      const journey = await Journey.findOne({ userId, status: { $in: ['active', 'paused'] } }).lean();
      const overallScore = knowledgeProfile?.overallScore || 0;
      const journeyProgress = journey?.progress?.overallPercentage || 0;
      const streak = journey?.progress?.currentStreak || 0;

      data.readinessScore = Math.round((overallScore * 0.4) + (journeyProgress * 0.3) + (Math.min(100, streak * 10) * 0.3));
      data.streak = streak;
      data.topicMastery = knowledgeProfile?.topicMastery || [];
      data.strengths = knowledgeProfile?.strengths?.slice(0, 5) || [];
      data.weaknesses = knowledgeProfile?.weaknesses?.slice(0, 5) || [];
      data.totalQuizzesTaken = knowledgeProfile?.totalQuizzesTaken || 0;
      data.totalTopicsCovered = knowledgeProfile?.totalTopicsCovered || 0;

    } else if (intent === 'interview') {
      data.interviewReady = true;
      data.suggestedType = _inferInterviewType(primaryObjective);
      data.targetRole = primaryObjective?.specifics?.targetRole || goalTitle;

    } else if (intent === 'create_content') {
      data.createContentReady = true;

    } else {
      // General — return a mix
      let content = [];
      try {
        const feed = await recommendationService.getPersonalizedFeed(userId, { page: 1, limit: 5 });
        content = feed.items || [];
      } catch (e) {}
      data.content = content;
    }

    res.json(apiResponse.success({
      intent,
      topic,
      coachMessage,
      actionLabel,
      data,
    }, 'Intent processed'));

  } catch (err) {
    console.error('📅 TODAY INTENT ERROR:', err);
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function _getTodayChallengesWithStatus(userId) {
  const today = _todayIST();
  const challenges = await DailyChallenge.find({ date: today, status: 'active' })
    .select('-questions.correctAnswer -questions.explanation').lean();
  if (!challenges.length) return [];
  const attempts = await ChallengeAttempt.find({ userId, challengeId: { $in: challenges.map(c => c._id) }, status: 'completed' }).lean();
  const attemptMap = {};
  attempts.forEach(a => { attemptMap[a.challengeId.toString()] = a; });
  return challenges.map(c => ({
    ...c,
    userCompleted: !!attemptMap[c._id.toString()],
    userScore: attemptMap[c._id.toString()]?.score || null,
  }));
}

function _deriveSkills(objective) {
  if (!objective) return [];
  if (objective.topicsOfInterest?.length) return objective.topicsOfInterest.map(t => ({ name: t, source: 'objective' }));
  const type = objective.objectiveType;
  const role = objective.specifics?.targetRole?.toLowerCase() || '';
  if (type === 'interview_preparation') {
    if (role.includes('product')) return ['Product Strategy', 'User Research', 'Metrics & Analytics', 'Roadmapping', 'Stakeholder Management'].map(s => ({ name: s, source: 'derived' }));
    if (role.includes('engineer') || role.includes('developer')) return ['System Design', 'Data Structures', 'Algorithms', 'API Design', 'Problem Solving'].map(s => ({ name: s, source: 'derived' }));
    return ['Communication', 'Problem Solving', 'Technical Skills', 'Behavioral Questions', 'System Design'].map(s => ({ name: s, source: 'derived' }));
  }
  return ['Learning', 'Practice', 'Assessment', 'Review'].map(s => ({ name: s, source: 'derived' }));
}

function _inferInterviewType(objective) {
  const type = objective?.objectiveType;
  if (type === 'interview_preparation') {
    const role = objective?.specifics?.targetRole?.toLowerCase() || '';
    if (role.includes('mba')) return 'mba_admissions';
    return 'placement_hr';
  }
  return 'behavioral';
}

function _todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split('T')[0];
}

module.exports = { getSummary, processIntent };
