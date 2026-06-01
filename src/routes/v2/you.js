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
const mongoose = require('mongoose');
const auth = require('../../middleware/auth');
const User = require('../../models/User');
const UserObjective = require('../../models/UserObjective');
const Plan = require('../../models/Plan');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const CompetitionProfile = require('../../models/CompetitionProfile');
const Journey = require('../../models/Journey');
const Quiz = require('../../models/Quiz');
const QuizAttempt = require('../../models/QuizAttempt');
const Content = require('../../models/Content');
const ContentProgress = require('../../models/ContentProgress');
const InterviewSession = require('../../models/InterviewSession');
const CognitiveProfile = require('../../models/CognitiveProfile');
const CompassConversation = require('../../models/CompassConversation');
const Conversation = require('../../models/Conversation');
const CreatorProfile = require('../../models/CreatorProfile');
const CreatorApplication = require('../../models/CreatorApplication');
const DiagnosticAttempt = require('../../models/DiagnosticAttempt');
const planService = require('../../services/v2/planService');
const readinessUpdater = require('../../coding/services/readinessUpdater');
const { evaluateCodingEligibility } = require('../../coding/services/codingEligibility');

const router = express.Router();

router.get('/overview', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [user, objective, plan, journey, knowledge, competition, creatorProfile, latestApplication] = await Promise.all([
      User.findById(userId).select('firstName lastName profilePicture role').lean(),
      UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
      Plan.findOne({ userId, status: { $in: ['active', 'ready'] } }).lean(),
      Journey.findOne({ userId, status: 'active' }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
      CompetitionProfile.findOne({ userId }).lean(),
      // CreatorProfile.tier is set on approval (enum: rising | core | anchor)
      CreatorProfile.findOne({ userId }).select('tier').lean(),
      // Newest application — drives the `applicationStatus` flag.
      CreatorApplication.findOne({ userId }).sort({ createdAt: -1 }).select('status').lean(),
    ]);

    // Readiness — single source of truth (readinessService). Behavior-identical
    // to the previous inline computation; the bounded coding blend now lives in
    // the service. MetaSkillMastery is written by BOTH drills and capstones, so
    // the coding component reflects all coding practice; its weight ramps 0→0.10
    // as combined attempts go 5→10 (backfill-safe), bounded to 0..100.
    const readinessService = require('../../services/readiness/readinessService');
    let codingComponent = null;
    try {
      const elig = evaluateCodingEligibility(objective);
      if (elig.eligible) {
        codingComponent = await readinessUpdater.getMetaSkillComponent({ user_id: userId, role_track: elig.role_track });
      }
    } catch (e) {
      console.warn('[v2/you/overview] coding component fetch skipped:', e.message);
    }
    const legacy = readinessService.assembleLegacy({ plan, journey, knowledge, codingComponent });
    const readiness = legacy.value;
    const codingForResponse = legacy.coding; // {value,weight,attempt_count} | null

    // Phase 1 SHADOW: compute the multi-primitive composite alongside legacy.
    // Best-effort; on any failure we keep serving `legacy`. Stored on the
    // snapshot for old-vs-new diffing. Served only behind FEATURE_COMPOSITE_READINESS.
    let shadow = null;
    try {
      if (objective?.analysis?.competencies?.length) {
        const cms = require('../../services/readiness/competencyMasteryService');
        const elig = evaluateCodingEligibility(objective);
        const now = new Date();
        const CapstoneSession = mongoose.model('CapstoneSession');
        const DrillAttempt = mongoose.model('DrillAttempt');
        const MetaSkillMastery = mongoose.model('MetaSkillMastery');
        const [capstones, drills, mastery, interviews] = await Promise.all([
          elig.eligible ? CapstoneSession.find({ user_id: userId, status: 'graded' }).select('result.overall_score graded_at').sort({ graded_at: -1 }).limit(10).lean() : [],
          elig.eligible ? DrillAttempt.find({ user_id: userId, status: 'graded' }).select('grade.overall_score submitted_at').sort({ submitted_at: -1 }).limit(20).lean() : [],
          elig.eligible ? MetaSkillMastery.findOne({ user_id: userId, role_track: elig.role_track }).lean() : null,
          InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] } }).select('evaluation.overallScore completedAt').sort({ completedAt: -1 }).limit(10).lean(),
        ]);
        const codingSignal = elig.eligible ? cms.buildCodingSignal({ capstones, drills, mastery, now }) : null;
        const interviewSignal = cms.buildInterviewSignal({ interviews, now });
        const behavioral = cms.buildBehavioralSignal({ streak: competition?.currentStreak || 0, contentCompleted: 0, activeDays7: 0 });
        const composite = readinessService.computeComposite({ objective, ctx: { coding: !!elig.eligible }, knowledge, codingSignal, interviewSignal, behavioral, now });
        if (composite) {
          shadow = { value: composite.value, confidence: composite.confidence, breakdown: composite.breakdown, delta: composite.value - readiness };
          console.log(`[readiness-shadow] user=${userId} legacy=${readiness} composite=${composite.value} delta=${shadow.delta} conf=${composite.confidence}`);
        }
      }
    } catch (e) {
      console.warn('[v2/you/overview] shadow composite skipped:', e.message);
    }

    void readinessService.persistSnapshot({
      userId, objectiveId: objective?._id, value: readiness, source: legacy.source, shadow,
    });

    // Served value: legacy by default; composite only when the flag is on.
    const servedReadiness = (shadow && require('../../config/featureFlags').compositeReadiness)
      ? shadow.value
      : readiness;

    // Target date and weeks remaining / overdue
    let targetDateStr = null;
    let weeksRemaining = null;
    let weeksOverdue = null;
    if (objective?.targetDate) {
      const target = new Date(objective.targetDate);
      const now = new Date();
      const diffMs = target - now;
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays > 0) {
        weeksRemaining = Math.ceil(diffDays / 7);
      } else if (diffDays < 0) {
        weeksOverdue = Math.ceil(-diffDays / 7);
      }
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
          score: servedReadiness,
          onTrackText: computeOnTrackText({ readiness: servedReadiness, targetDateStr, weeksOverdue }),
          targetDate: targetDateStr,
          weeksRemaining,    // null when overdue
          weeksOverdue,      // set when target date has passed
          // Present only for coding objectives once the learner has enough
          // practice for coding to influence readiness (else null). Lets the
          // client explain "coding practice is shaping your readiness".
          coding: codingForResponse,
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
          // Extended for v2 "You" tab restructure — drives the role-aware section
          // headers (creator stats vs application status vs consumer-only).
          role: user?.role || 'consumer',
          creatorTier: user?.role === 'creator' ? (creatorProfile?.tier || null) : null,
          // Map the application document's status (pending | endorsed | approved | rejected)
          // down to the three states the iOS client cares about. `endorsed` is
          // a pre-approval state — surface it as pending so the user sees
          // "we're reviewing this" rather than a misleading "approved".
          applicationStatus: latestApplication
            ? (latestApplication.status === 'endorsed' ? 'pending' : latestApplication.status)
            : null,
        },
        objectiveLabel: buildObjectiveLabel(objective),
      },
    });
  } catch (err) {
    console.error('[v2/you/overview] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load overview' });
  }
});

/**
 * Compute the onTrackText string for the readiness ring.
 * Never duplicates the percentage shown in the ring — returns a meaningful
 * status phrase per band instead.
 *
 * @param {{ readiness: number, targetDateStr: string|null, weeksOverdue: number|null }} opts
 * @returns {string}
 */
function computeOnTrackText({ readiness, targetDateStr, weeksOverdue }) {
  if (weeksOverdue !== null) {
    return 'Past deadline · keep pushing';
  }
  if (readiness >= 70) {
    return `On track for ${targetDateStr || 'your target'}`;
  }
  if (readiness >= 40) {
    return `Building readiness toward ${targetDateStr || 'target'}`;
  }
  return 'Early days · keep going';
}

function computeReadinessFromKnowledge(knowledge) {
  if (!knowledge) return null;
  // Prefer the precomputed overall score on the document (this is what the
  // analytics view displays as "Overall knowledge"). Fall back to averaging
  // topicMastery entries when overallScore hasn't been populated yet.
  if (typeof knowledge.overallScore === 'number' && knowledge.overallScore > 0) {
    return Math.round(knowledge.overallScore);
  }
  if (Array.isArray(knowledge.topicMastery) && knowledge.topicMastery.length > 0) {
    const sum = knowledge.topicMastery.reduce((s, t) => s + (t.score || 0), 0);
    return Math.round(sum / knowledge.topicMastery.length);
  }
  // Legacy: some older docs may have a `topicProfiles` map.
  if (knowledge.topicProfiles) {
    const entries = Object.values(knowledge.topicProfiles);
    if (entries.length > 0) {
      const avg = entries.reduce((s, t) => s + (t.masteryLevel || 0), 0) / entries.length;
      return Math.round(avg);
    }
  }
  return null;
}

function pickTopGap(knowledge) {
  if (!knowledge) return null;
  // topicMastery is the canonical array shape (matches KnowledgeProfile model).
  if (Array.isArray(knowledge.topicMastery) && knowledge.topicMastery.length > 0) {
    const candidates = knowledge.topicMastery
      .map(t => ({ topic: t.topic, mastery: t.score || 0 }))
      .filter(t => t.topic && t.mastery < 70)
      .sort((a, b) => a.mastery - b.mastery);
    if (candidates.length > 0) return candidates[0];
  }
  // Legacy: topicProfiles map.
  if (knowledge.topicProfiles) {
    const entries = Object.entries(knowledge.topicProfiles)
      .map(([topic, t]) => ({ topic, mastery: t.masteryLevel || 0 }))
      .filter(t => t.mastery < 70)
      .sort((a, b) => a.mastery - b.mastery);
    return entries[0] || null;
  }
  return null;
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

    // --- Coding (drills + capstones) — surfaced in the deep You/analytics tab ---
    let coding = null;
    let recentDrills = [];
    let recentCapstones = [];
    try {
      const DrillAttempt = mongoose.model('DrillAttempt');
      const CapstoneSession = mongoose.model('CapstoneSession');
      const MetaSkillMastery = mongoose.model('MetaSkillMastery');
      const DifficultyState = mongoose.model('DifficultyState');
      const uid = new mongoose.Types.ObjectId(String(userId));
      const [drillsGraded, capstonesGraded, drillAvgAgg, capAvgAgg, masteryDocs, diffStates, dRecent, cRecent] =
        await Promise.all([
          DrillAttempt.countDocuments({ user_id: userId, status: 'graded' }),
          CapstoneSession.countDocuments({ user_id: userId, status: 'graded' }),
          DrillAttempt.aggregate([{ $match: { user_id: uid, status: 'graded' } }, { $group: { _id: null, avg: { $avg: '$grade.overall_score' } } }]),
          CapstoneSession.aggregate([{ $match: { user_id: uid, status: 'graded' } }, { $group: { _id: null, avg: { $avg: '$result.overall_score' } } }]),
          MetaSkillMastery.find({ user_id: userId }).lean(),
          DifficultyState.find({ user_id: userId }).lean(),
          DrillAttempt.find({ user_id: userId, status: 'graded' }).select('drill_subtype grade.overall_score submitted_at').sort({ submitted_at: -1 }).limit(10).lean(),
          CapstoneSession.find({ user_id: userId, status: 'graded' }).select('result.overall_score graded_at').sort({ graded_at: -1 }).limit(10).lean(),
        ]);
      recentDrills = dRecent;
      recentCapstones = cRecent;
      if (drillsGraded > 0 || capstonesGraded > 0 || masteryDocs.length > 0) {
        coding = {
          drillsGraded,
          capstonesGraded,
          avgDrillScore: drillAvgAgg[0]?.avg != null ? Math.round(drillAvgAgg[0].avg) : null,
          avgCapstoneScore: capAvgAgg[0]?.avg != null ? Math.round(capAvgAgg[0].avg) : null,
          tracks: masteryDocs.map((m) => ({
            role_track: m.role_track,
            axes: m.axes,
            attempt_count: m.attempt_count,
            current_difficulty: (diffStates.find((d) => d.role_track === m.role_track)?.current_difficulty) || 'easy',
          })),
        };
      }
    } catch (e) {
      console.warn('[v2/you/analytics] coding section skipped:', e.message);
    }

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
    for (const d of recentDrills) {
      activity.push({
        type: 'drill',
        at: d.submitted_at,
        title: `${(d.drill_subtype || 'coding').replace(/_/g, ' ')} drill`,
        detail: d.grade?.overall_score != null ? `${Math.round(d.grade.overall_score)}/100` : null,
      });
    }
    for (const c of recentCapstones) {
      activity.push({
        type: 'capstone',
        at: c.graded_at,
        title: 'Capstone graded',
        detail: c.result?.overall_score != null ? `${Math.round(c.result.overall_score)}/100` : null,
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
        coding, // null until the user has any graded drill/capstone
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

/**
 * GET /api/v2/you/plan/detail
 *
 * Comprehensive plan view for the v2 "You" tab. Surfaces every detail the user
 * needs to trust the plan: objective + write-up, summary counts, milestones,
 * named phases, per-week breakdown, topic coverage, and completed history.
 *
 * Deterministic — no LLM call in the request path (write-up is template-based).
 */
router.get('/plan/detail', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [user, objective, plan, knowledge, latestAttempt] = await Promise.all([
      User.findById(userId).select('firstName').lean(),
      UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
      Plan.findOne({ userId, isActive: true }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
      DiagnosticAttempt.findOne({ userId, status: 'completed' })
        .sort({ completedAt: -1 }).lean(),
    ]);

    if (!objective) {
      return res.status(404).json({ success: false, message: 'No active objective' });
    }
    if (!plan) {
      // Honest empty state — iOS shows a "Your plan is being personalized" view.
      return res.json({
        success: true,
        data: {
          objective: {
            label: buildObjectiveLabel(objective),
            type: objective.objectiveType,
            specifics: objective.specifics || {},
            createdAt: objective.createdAt,
            targetDate: objective.targetDate || null,
            currentLevel: objective.currentLevel,
            writeUp: 'Your plan is still being personalized. Check back in a moment.',
          },
          summary: null, milestones: [], phases: [],
          weeks: [], topicCoverage: [], completedHistory: [],
        },
      });
    }

    // Baseline + target readiness — mirror /plan/today so numbers line up.
    const baseline = diagnosticBaselineReadiness(latestAttempt)
      ?? computeReadinessFromKnowledge(knowledge)
      ?? 30;
    // Phase 2: objective-aware target (flag-gated; FEATURE_OBJECTIVE_TARGET off => 80).
    // Persist it best-effort so the value + history are available to other surfaces.
    const targetService = require('../../services/readiness/targetService');
    const targetReadiness = await targetService.ensureTarget(objective, 'plan_view');

    // Earliest week with non-complete tasks = the current week.
    const firstIncomplete = plan.weeklySchedule.find(w =>
      (w.tasks || []).some(t => t.progress?.status !== 'complete')
    );
    const currentWeek = firstIncomplete?.week || (plan.weeklySchedule || []).length || 1;

    const phases = planService.buildPhases({ plan, objective });
    const milestones = planService.buildMilestones({
      plan, phases, baseline, targetReadiness, currentWeek, objective,
    });
    const weeks = planService.buildWeeksDetail({ plan, baseline, targetReadiness, currentWeek });
    const topicCoverage = planService.buildTopicCoverage({ plan, knowledge });
    const summary = planService.buildPlanSummary({ plan, baseline, targetReadiness, objective });
    // Readiness zones around the target (Competitive / Strong / Exceptional) for the UI.
    summary.targetBands = targetService.targetBands(targetReadiness);
    const completedHistory = await planService.buildCompletedHistory({ plan, userId });
    const writeUp = planService.buildPlanWriteUp({ plan, objective, knowledge });

    return res.json({
      success: true,
      data: {
        objective: {
          label: buildObjectiveLabel(objective),
          type: objective.objectiveType,
          specifics: objective.specifics || {},
          createdAt: objective.createdAt,
          targetDate: objective.targetDate || null,
          currentLevel: objective.currentLevel,
          writeUp,
        },
        summary,
        milestones,
        phases,
        weeks,
        topicCoverage,
        completedHistory,
      },
    });
  } catch (err) {
    console.error('[v2/you/plan/detail] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load plan detail' });
  }
});

/**
 * GET /api/v2/you/compass/history
 *
 * List the user's Compass conversation threads (newest first). Each thread
 * shows enough metadata for the iOS list row without dragging the full
 * message transcript over the wire.
 *
 * Query params:
 *   sessionId — when present, return the full transcript for that one thread
 *               instead of the paginated list.
 *   page, limit — pagination for the list view (defaults: page=1, limit=20).
 */
router.get('/compass/history', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { sessionId } = req.query;

    // Single-thread transcript fetch.
    if (sessionId) {
      if (!mongoose.Types.ObjectId.isValid(sessionId)) {
        return res.status(400).json({ success: false, message: 'Invalid sessionId' });
      }
      const thread = await CompassConversation.findOne({ _id: sessionId, userId }).lean();
      if (!thread) {
        return res.status(404).json({ success: false, message: 'Session not found' });
      }
      const messages = (thread.messages || []).map(m => ({
        role: m.role,
        // Defensive truncation — historical messages may exceed our new cap.
        content: typeof m.content === 'string' ? m.content.slice(0, 4000) : '',
        mode: m.mode || null,
        contentRef: m.contentRef ? String(m.contentRef) : null,
        contentTitle: m.contentTitle || null,
        createdAt: m.createdAt,
      }));
      return res.json({
        success: true,
        data: {
          sessionId: String(thread._id),
          title: thread.title || 'Conversation',
          startedAt: thread.createdAt,
          endedAt: thread.lastMessageAt || thread.updatedAt,
          messageCount: thread.messageCount || messages.length,
          isArchived: !!thread.isArchived,
          messages,
        },
      });
    }

    // Paginated session list.
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [threads, totalCount] = await Promise.all([
      CompassConversation.find({ userId })
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .skip(skip).limit(limit)
        .lean(),
      CompassConversation.countDocuments({ userId }),
    ]);

    const sessions = threads.map(t => {
      const msgs = t.messages || [];
      const firstUser = msgs.find(m => m.role === 'user');
      // Last assistant turn — walk back from the end.
      let lastAssistant = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') { lastAssistant = msgs[i]; break; }
      }
      // Mode summary: pick the most-common non-greeting mode, falling back to
      // the dominant scope inferred from the messages. Coach/tutor are the
      // useful labels to surface in the list.
      const modeCounts = new Map();
      for (const m of msgs) {
        if (!m.mode || m.mode === 'greeting') continue;
        modeCounts.set(m.mode, (modeCounts.get(m.mode) || 0) + 1);
      }
      let primaryMode = 'conversation';
      let primaryModeCount = 0;
      for (const [mode, count] of modeCounts.entries()) {
        if (count > primaryModeCount) { primaryMode = mode; primaryModeCount = count; }
      }
      // Tutor mode threads — surface the content title as topic.
      const tutorMsg = msgs.find(m => m.mode === 'tutor' && m.contentTitle);
      return {
        sessionId: String(t._id),
        title: t.title || 'Conversation',
        mode: primaryMode,
        startedAt: t.createdAt,
        endedAt: t.lastMessageAt || t.updatedAt,
        messageCount: t.messageCount || msgs.length,
        isArchived: !!t.isArchived,
        firstUserMessage: firstUser
          ? (typeof firstUser.content === 'string' ? firstUser.content.slice(0, 200) : null)
          : null,
        lastAssistantMessage: lastAssistant
          ? (typeof lastAssistant.content === 'string' ? lastAssistant.content.slice(0, 200) : null)
          : null,
        topic: tutorMsg?.contentTitle || null,
        scope: null, // Scope isn't stored per-thread today — placeholder for the iOS UI.
      };
    });

    return res.json({
      success: true,
      data: {
        sessions,
        pagination: {
          page, limit, total: totalCount,
          hasMore: skip + sessions.length < totalCount,
        },
      },
    });
  } catch (err) {
    console.error('[v2/you/compass/history] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load Compass history' });
  }
});

/**
 * GET /api/v2/you/activities
 *
 * Unified activity history across quiz, interview, content, and AI tutor.
 * Returns lifetime counts, this-week counts, the merged recent timeline,
 * and per-type analytics (trend, avg score by topic, etc.).
 */
router.get('/activities', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    // ── Window helpers ───────────────────────────────────────────────────────
    const now = new Date();
    const startOfWeek = (() => {
      const d = new Date(now);
      const dayOfWeek = (d.getDay() + 6) % 7; // 0 = Monday
      d.setDate(d.getDate() - dayOfWeek);
      d.setHours(0, 0, 0, 0);
      return d;
    })();

    const [
      quizAttempts, interviews, contentProgress, tutorConversations,
      quizCountWeek, interviewCountWeek, contentCountWeek, tutorCountWeek,
    ] = await Promise.all([
      QuizAttempt.find({ userId, status: 'completed' })
        .sort({ completedAt: -1 }).limit(100)
        .select('score topicBreakdown completedAt totalTime quizId').lean(),
      InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] } })
        .sort({ completedAt: -1 }).limit(50)
        .select('interviewType targetRole evaluation.overallScore completedAt duration objectiveId').lean(),
      ContentProgress.find({ userId })
        .sort({ lastSessionAt: -1 }).limit(100)
        .select('isCompleted completedAt totalTimeSpent percentageCompleted lastSessionAt contentId').lean(),
      // v1 per-content AI Tutor history — Conversation model.
      Conversation.find({ userId })
        .sort({ lastMessageAt: -1 }).limit(50)
        .select('contentId contentTitle contentDomain messageCount lastMessageAt createdAt').lean(),
      QuizAttempt.countDocuments({ userId, status: 'completed', completedAt: { $gte: startOfWeek } }),
      InterviewSession.countDocuments({ userId, status: { $in: ['completed', 'evaluated'] }, completedAt: { $gte: startOfWeek } }),
      ContentProgress.countDocuments({ userId, isCompleted: true, completedAt: { $gte: startOfWeek } }),
      Conversation.countDocuments({ userId, lastMessageAt: { $gte: startOfWeek } }),
    ]);

    const completedQuizzes = quizAttempts.filter(q => q.completedAt);
    const completedInterviews = interviews.filter(i => i.completedAt);
    const completedContent = contentProgress.filter(c => c.isCompleted);

    // ── Minutes math (totalTimeSpent is seconds for content, seconds for interviews) ─
    const contentMinutes = Math.round(
      contentProgress.reduce((s, c) => s + (c.totalTimeSpent || 0), 0) / 60
    );
    const interviewMinutes = Math.round(
      completedInterviews.reduce((s, i) => s + (i.duration || 0), 0) / 60
    );
    const quizMinutes = Math.round(
      completedQuizzes.reduce((s, q) => s + (q.totalTime || 0), 0) / 60
    );
    const totalMinutes = contentMinutes + interviewMinutes + quizMinutes;

    const thisWeekMinutes = Math.round(
      contentProgress
        .filter(c => c.completedAt && new Date(c.completedAt) >= startOfWeek)
        .reduce((s, c) => s + (c.totalTimeSpent || 0), 0) / 60
      + completedInterviews
        .filter(i => new Date(i.completedAt) >= startOfWeek)
        .reduce((s, i) => s + (i.duration || 0), 0) / 60
      + completedQuizzes
        .filter(q => new Date(q.completedAt) >= startOfWeek)
        .reduce((s, q) => s + (q.totalTime || 0), 0) / 60
    );

    // summary is finalised after the drill query below patches in codingDrills.
    const summary = {
      totalQuizzes: completedQuizzes.length,
      totalInterviews: completedInterviews.length,
      totalContentWatched: completedContent.length,
      totalAITutorSessions: tutorConversations.length,
      totalMinutes,
      thisWeek: {
        quizzes: quizCountWeek,
        interviews: interviewCountWeek,
        contentWatched: contentCountWeek,
        aiTutorSessions: tutorCountWeek,
        totalMinutes: thisWeekMinutes,
      },
    };

    // ── Unified recent timeline (last 50 newest-first) ───────────────────────
    const recent = [];

    // Hydrate quiz titles in one query (avoid N+1).
    const quizIds = Array.from(new Set(completedQuizzes.map(q => String(q.quizId)).filter(Boolean)));
    let quizMeta = new Map();
    if (quizIds.length > 0) {
      try {
        const quizDocs = await Quiz.find({ _id: { $in: quizIds } })
          .select('title topic type objectiveId').lean();
        for (const q of quizDocs) quizMeta.set(String(q._id), q);
      } catch (_) {}
    }

    for (const q of completedQuizzes.slice(0, 25)) {
      const meta = quizMeta.get(String(q.quizId)) || {};
      recent.push({
        type: 'quiz',
        id: String(q._id),
        title: meta.title || 'Quiz',
        topic: meta.topic || (q.topicBreakdown?.[0]?.topic) || null,
        score: Math.round(q.score?.percentage || 0),
        completedAt: q.completedAt,
        durationMin: Math.round((q.totalTime || 0) / 60),
        // For-fun vs linked-to-objective — surfaced so iOS can show the chip
        // without a second round-trip. `objectiveId` is the source of truth.
        linkedToObjective: !!meta.objectiveId,
      });
    }
    for (const i of completedInterviews.slice(0, 15)) {
      recent.push({
        type: 'interview',
        id: String(i._id),
        title: `${(i.interviewType || 'interview').replace(/_/g, ' ')}${i.targetRole ? ` — ${i.targetRole}` : ''}`,
        topic: i.interviewType || null,
        score: i.evaluation?.overallScore != null ? Math.round(i.evaluation.overallScore) : null,
        completedAt: i.completedAt,
        durationMin: Math.round((i.duration || 0) / 60),
      });
    }
    // Hydrate content titles in one query.
    const contentIds = Array.from(new Set(completedContent.slice(0, 25).map(c => String(c.contentId)).filter(Boolean)));
    let contentMeta = new Map();
    if (contentIds.length > 0) {
      try {
        const docs = await Content.find({ _id: { $in: contentIds } })
          .select('title topics domain creatorId').lean();
        for (const d of docs) contentMeta.set(String(d._id), d);
      } catch (_) {}
    }
    for (const c of completedContent.slice(0, 25)) {
      const meta = contentMeta.get(String(c.contentId)) || {};
      recent.push({
        type: 'content',
        id: String(c._id),
        title: meta.title || 'Content',
        topic: (meta.topics || [])[0] || meta.domain || null,
        score: null,
        completedAt: c.completedAt || c.lastSessionAt,
        durationMin: Math.round((c.totalTimeSpent || 0) / 60),
      });
    }
    for (const t of tutorConversations.slice(0, 20)) {
      recent.push({
        type: 'ai_tutor',
        id: String(t._id),
        title: t.contentTitle ? `Tutor — ${t.contentTitle}` : 'Tutor session',
        topic: t.contentDomain || null,
        score: null,
        completedAt: t.lastMessageAt || t.createdAt,
        durationMin: null,
        messageCount: t.messageCount || 0,
      });
    }

    // Coding drill attempts
    let drillCountWeek = 0;
    let drillByType = { totalDrills: 0, averageScore: null, totalMinutes: 0 };
    try {
      const drillAttempts = await mongoose.model('DrillAttempt').find({
        user_id: userId,
        status: 'graded',
      }).sort({ submitted_at: -1 }).limit(50).lean();

      drillCountWeek = await mongoose.model('DrillAttempt').countDocuments({
        user_id: userId,
        status: 'graded',
        submitted_at: { $gte: startOfWeek },
      });

      if (drillAttempts.length > 0) {
        const bundleIds = [...new Set(drillAttempts.map(a => a.bundle_id))];
        const bundles = await mongoose.model('ArtifactBundle').find({
          _id: { $in: bundleIds },
        }).select('drill_subtype role_track difficulty brief').lean();
        const bundleById = Object.fromEntries(bundles.map(b => [String(b._id), b]));

        for (const a of drillAttempts.slice(0, 25)) {
          const bundle = bundleById[String(a.bundle_id)] || {};
          recent.push({
            type: 'coding_drill',
            id: String(a._id),
            title: `${(a.drill_subtype || 'Drill').replace(/^./, c => c.toUpperCase())} drill`,
            topic: bundle.role_track || null,
            score: a.grade?.overall_score ?? null,
            completedAt: a.submitted_at,
            durationMin: null,
            meta: {
              drill_subtype: a.drill_subtype,
              role_track: bundle.role_track,
              difficulty: bundle.difficulty,
              is_calibration: a.is_calibration || false,
            },
          });
        }

        // Summary stats for byType
        const scores = drillAttempts
          .map(a => a.grade?.overall_score)
          .filter(s => typeof s === 'number');
        drillByType = {
          totalDrills: drillAttempts.length,
          averageScore: scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null,
          totalMinutes: 0, // drills don't track duration today
        };
      }
    } catch (e) {
      console.error('[v2/you/activities] coding drill enrichment failed:', e.message);
    }

    recent.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
    const recentCapped = recent.filter(r => r.completedAt).slice(0, 50);

    // ── Per-type analytics ───────────────────────────────────────────────────

    // Quiz: trend (last 20 oldest-first), avg overall, avg by topic, direction
    const trendSrc = completedQuizzes.slice(0, 20).reverse();
    const quizTrend = trendSrc.map(q => ({
      date: q.completedAt,
      score: Math.round(q.score?.percentage || 0),
    }));
    const avgQuiz = completedQuizzes.length
      ? Math.round(completedQuizzes.reduce((s, q) => s + (q.score?.percentage || 0), 0) / completedQuizzes.length)
      : null;
    const topicSumMap = new Map(); // topic → { sum, count }
    for (const q of completedQuizzes) {
      for (const tb of (q.topicBreakdown || [])) {
        if (!tb?.topic || typeof tb.percentage !== 'number') continue;
        const entry = topicSumMap.get(tb.topic) || { sum: 0, count: 0 };
        entry.sum += tb.percentage; entry.count += 1;
        topicSumMap.set(tb.topic, entry);
      }
    }
    const avgScoreByTopic = Array.from(topicSumMap.entries())
      .map(([topic, v]) => ({ topic, avgScore: Math.round(v.sum / v.count), attempts: v.count }))
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, 10);
    let quizDirection = 'stable';
    if (completedQuizzes.length >= 6) {
      const recentSlice = completedQuizzes.slice(0, 3);
      const priorSlice = completedQuizzes.slice(3, 6);
      const avg = arr => arr.reduce((s, q) => s + (q.score?.percentage || 0), 0) / arr.length;
      const delta = avg(recentSlice) - avg(priorSlice);
      quizDirection = delta > 5 ? 'improving' : delta < -5 ? 'declining' : 'stable';
    }

    // Interview analytics
    const avgInterview = completedInterviews.length
      ? Math.round(
          completedInterviews
            .filter(i => i.evaluation?.overallScore != null)
            .reduce((s, i) => s + i.evaluation.overallScore, 0)
          / Math.max(1, completedInterviews.filter(i => i.evaluation?.overallScore != null).length)
        )
      : null;
    const interviewByType = new Map();
    for (const i of completedInterviews) {
      const t = i.interviewType || 'other';
      const entry = interviewByType.get(t) || { count: 0, scoreSum: 0, scoreCount: 0 };
      entry.count += 1;
      if (i.evaluation?.overallScore != null) {
        entry.scoreSum += i.evaluation.overallScore;
        entry.scoreCount += 1;
      }
      interviewByType.set(t, entry);
    }
    const interviewBreakdown = Array.from(interviewByType.entries())
      .map(([type, v]) => ({
        type,
        count: v.count,
        avgScore: v.scoreCount ? Math.round(v.scoreSum / v.scoreCount) : null,
      }));

    const byType = {
      quizzes: {
        trend: quizTrend,
        averageScore: avgQuiz,
        direction: quizDirection,
        avgScoreByTopic,
        totalMinutes: quizMinutes,
      },
      interviews: {
        averageScore: avgInterview,
        breakdownByType: interviewBreakdown,
        totalMinutes: interviewMinutes,
      },
      content: {
        totalCompleted: completedContent.length,
        totalMinutes: contentMinutes,
        inProgress: contentProgress.filter(c => !c.isCompleted && (c.percentageCompleted || 0) > 0).length,
      },
      ai_tutor: {
        totalSessions: tutorConversations.length,
        totalMessages: tutorConversations.reduce((s, t) => s + (t.messageCount || 0), 0),
      },
      coding_drills: drillByType,
    };

    // Patch drill this-week count in now that the drill query has run.
    summary.thisWeek.codingDrills = drillCountWeek;
    summary.totalCodingDrills = drillByType.totalDrills;

    return res.json({
      success: true,
      data: { summary, recent: recentCapped, byType },
    });
  } catch (err) {
    console.error('[v2/you/activities] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load activities' });
  }
});

/**
 * GET /api/v2/you/coding-mastery
 *
 * Returns the authenticated user's coding meta-skill mastery per role_track,
 * current difficulty state, recent drill attempts (last 10), and aggregate
 * stats.  Returns 200 with empty payload if the user has no MetaSkillMastery
 * docs yet — so iOS can render an empty state instead of 404-handling.
 */
router.get('/coding-mastery', auth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?._id || req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'unauthorized' });

    const MetaSkillMastery = mongoose.model('MetaSkillMastery');
    const DifficultyState = mongoose.model('DifficultyState');
    const DrillAttempt = mongoose.model('DrillAttempt');
    const ArtifactBundle = mongoose.model('ArtifactBundle');
    const CapstoneSession = mongoose.model('CapstoneSession');

    const [
      masteryDocs,
      diffStates,
      recentAttempts,
      allGraded,
      avgScoreAgg,
      recentCapstones,
      allCapstonesGraded,
      avgCapstoneAgg,
    ] = await Promise.all([
      MetaSkillMastery.find({ user_id: userId }).lean(),
      DifficultyState.find({ user_id: userId }).lean(),
      DrillAttempt.find({ user_id: userId, status: 'graded' })
        .sort({ submitted_at: -1 }).limit(10).lean(),
      DrillAttempt.countDocuments({ user_id: userId, status: 'graded' }),
      DrillAttempt.aggregate([
        { $match: { user_id: new mongoose.Types.ObjectId(String(userId)), status: 'graded' } },
        { $group: { _id: null, avg: { $avg: '$grade.overall_score' } } },
      ]),
      // Capstone results now surface in Progress alongside drills.
      CapstoneSession.find({ user_id: userId, status: 'graded' })
        .sort({ graded_at: -1 }).limit(10)
        .populate('bundle_id', 'brief difficulty role_track').lean(),
      CapstoneSession.countDocuments({ user_id: userId, status: 'graded' }),
      CapstoneSession.aggregate([
        { $match: { user_id: new mongoose.Types.ObjectId(String(userId)), status: 'graded' } },
        { $group: { _id: null, avg: { $avg: '$result.overall_score' } } },
      ]),
    ]);

    const avgScore = avgScoreAgg[0]?.avg ? Math.round(avgScoreAgg[0].avg) : null;
    const avgCapstoneScore = avgCapstoneAgg[0]?.avg ? Math.round(avgCapstoneAgg[0].avg) : null;

    // Capstone results — overall_score is 0..100 (distinct from drills); the
    // brief's first line is the title.
    const capstonesView = recentCapstones.map((s) => {
      const b = s.bundle_id && typeof s.bundle_id === 'object' ? s.bundle_id : {};
      const firstLine = b.brief
        ? (String(b.brief).split('\n').find((l) => l.trim().length > 0) || '').trim()
        : '';
      return {
        id: String(s._id),
        bundle_id: b._id ? String(b._id) : (s.bundle_id ? String(s.bundle_id) : null),
        title: firstLine.length > 100 ? firstLine.slice(0, 100).trimEnd() + '…' : firstLine,
        difficulty: b.difficulty ?? null,
        role_track: b.role_track ?? null,
        overall_score: s.result?.overall_score ?? null,
        integrity_confidence: s.result?.integrity_confidence ?? null,
        graded_at: s.graded_at,
        is_retry: Boolean(s.is_retry),
      };
    });

    // Enrich recent attempts with bundle subtype/difficulty
    let attemptsView = [];
    if (recentAttempts.length > 0) {
      const bundleIds = [...new Set(recentAttempts.map(a => a.bundle_id))];
      const bundles = await ArtifactBundle.find({ _id: { $in: bundleIds } })
        .select('drill_subtype difficulty role_track').lean();
      const bundleById = Object.fromEntries(bundles.map(b => [String(b._id), b]));
      attemptsView = recentAttempts.map(a => {
        const b = bundleById[String(a.bundle_id)] || {};
        return {
          id: String(a._id),
          drill_subtype: a.drill_subtype || b.drill_subtype,
          difficulty: b.difficulty,
          role_track: b.role_track,
          score: a.grade?.overall_score ?? null,
          submitted_at: a.submitted_at,
          is_calibration: a.is_calibration || false,
        };
      });
    }

    // Per-track view: join mastery with difficulty state
    const tracks = masteryDocs.map(m => {
      const ds = diffStates.find(d => d.role_track === m.role_track);
      return {
        role_track: m.role_track,
        axes: m.axes,
        confidence: m.confidence,
        attempt_count: m.attempt_count,
        current_difficulty: ds?.current_difficulty || 'easy',
        recommendation_history: (ds?.recommendation_history || []).slice(-5),
      };
    });

    return res.json({
      success: true,
      data: {
        tracks,                         // [] if user has no MetaSkillMastery yet
        recent_attempts: attemptsView,  // []
        recent_capstones: capstonesView, // [] — graded capstone results
        stats: {
          total_drills_graded: allGraded,
          average_score: avgScore,
          total_capstones_graded: allCapstonesGraded,
          average_capstone_score: avgCapstoneScore,
        },
      },
    });
  } catch (err) {
    console.error('[v2/you/coding-mastery] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load coding mastery' });
  }
});

/**
 * Diagnostic baseline readiness (mirrors /plan/today). The average of
 * measured competency scores from the most-recent completed diagnostic.
 * Returns null when the diagnostic isn't usable so callers can fall back.
 */
function diagnosticBaselineReadiness(attempt) {
  if (!attempt) return null;
  const resultsMap = attempt.results instanceof Map
    ? Object.fromEntries(attempt.results)
    : (attempt.results || {});
  const scores = Object.values(resultsMap)
    .map(r => (r && typeof r.score === 'number' ? r.score : null))
    .filter(s => s !== null);
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
}

module.exports = router;
