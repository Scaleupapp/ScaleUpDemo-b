const { Queue } = require('bullmq');
const Redis = require('ioredis');
const User = require('../models/User');
const Quiz = require('../models/Quiz');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const Journey = require('../models/Journey');
const CreatorProfile = require('../models/CreatorProfile');
const Content = require('../models/Content');
const { quizGenerationQueue, notificationQueue, competitionQueue } = require('../config/queue');
const { resetStaleStreaks } = require('../services/streakService');

function startCronJobs() {
  // Use BullMQ repeatable jobs for cron scheduling
  const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const cronQueue = new Queue('cronJobs', { connection });

  // 1. Weekly Review Quiz — Every Sunday 6 PM IST (12:30 PM UTC)
  cronQueue.add('weeklyReviewQuiz', {}, {
    repeat: { pattern: '30 12 * * 0' },
    removeOnComplete: true,
  });

  // 2. Retention Check — Daily at midnight UTC
  cronQueue.add('retentionCheck', {}, {
    repeat: { pattern: '0 0 * * *' },
    removeOnComplete: true,
  });

  // 3. Quiz Expiry — Daily at 1 AM UTC
  cronQueue.add('quizExpiry', {}, {
    repeat: { pattern: '0 1 * * *' },
    removeOnComplete: true,
  });

  // 4. Re-engagement — Daily 4:30 AM UTC (10 AM IST)
  cronQueue.add('reEngagement', {}, {
    repeat: { pattern: '30 4 * * *' },
    removeOnComplete: true,
  });

  // 5. Creator Tier Check — Weekly Sunday midnight UTC
  cronQueue.add('creatorTierCheck', {}, {
    repeat: { pattern: '0 0 * * 0' },
    removeOnComplete: true,
  });

  // 6. Journey Week Advancement — Daily midnight UTC
  cronQueue.add('journeyAdvancement', {}, {
    repeat: { pattern: '0 0 * * *' },
    removeOnComplete: true,
  });

  // 7. Streak Reset — Daily 1:30 AM UTC (after journey advancement)
  cronQueue.add('streakReset', {}, {
    repeat: { pattern: '30 1 * * *' },
    removeOnComplete: true,
  });

  // 8. Account Deletion — Daily 2 AM UTC: permanent-delete expired deactivated accounts + send reminders
  cronQueue.add('accountDeletion', {}, {
    repeat: { pattern: '0 2 * * *' },
    removeOnComplete: true,
  });

  // 9. Flashcard Review Reminders — Daily 9 AM IST (3:30 AM UTC)
  cronQueue.add('flashcardReviewReminder', {}, {
    repeat: { pattern: '30 3 * * *' },
    removeOnComplete: true,
  });

  // 10. Re-calibration Offer — Daily 4:00 AM IST (22:30 UTC previous day)
  cronQueue.add('recalibrationOffer', {}, {
    repeat: { pattern: '30 22 * * *' },
    removeOnComplete: true,
  });

  // 11. Admin Question Digest — Monday 09:00 IST (03:30 UTC Monday)
  cronQueue.add('adminQuestionDigest', {}, {
    repeat: { pattern: '30 3 * * 1' },
    removeOnComplete: true,
  });

  // 12. Validator Backfill — Mondays 03:00 IST (21:30 UTC Sunday)
  cronQueue.add('validatorBackfill', {}, {
    repeat: { pattern: '30 21 * * 0' },
    removeOnComplete: true,
  });

  // 13. Mixpanel Daily Digest — Daily 09:00 IST (03:30 UTC)
  cronQueue.add('mixpanelDailyDigest', {}, {
    repeat: { pattern: '30 3 * * *' },
    removeOnComplete: true,
  });

  // 14. Diagnostic Health Check — Daily 04:00 IST (22:30 UTC prev day)
  cronQueue.add('diagnosticHealthCheck', {}, {
    repeat: { pattern: '30 22 * * *' },
    removeOnComplete: true,
  });

  // 15. Weekly Auto-Calibration — Daily 03:00 IST (21:30 UTC prev day)
  cronQueue.add('weeklyAutoCalibration', {}, {
    repeat: { pattern: '30 21 * * *' },
    removeOnComplete: true,
  });

  // 16. Daily Top-Gap Quizzes — Daily 00:15 IST (18:45 UTC prev day).
  // Seeds 3 ten-question quizzes per active user, targeted at their
  // weakest measured topics so they always have something to take.
  cronQueue.add('dailyTopGapQuizzes', {}, {
    repeat: { pattern: '45 18 * * *' },
    removeOnComplete: true,
  });

  // 17. Cohort directory housekeeping — Daily 02:30 IST (21:00 UTC prev day).
  cronQueue.add('cohortDirectoryHousekeeping', {}, {
    repeat: { pattern: '0 21 * * *' },
    removeOnComplete: true,
  });

  // 18. Agent Decision Expiry — Daily 03:15 IST (21:45 UTC prev day). Marks
  // pending agent decisions as ignored once they've sat unactioned past TTL.
  cronQueue.add('agentDecisionExpiry', {}, {
    repeat: { pattern: '45 21 * * *' },
    removeOnComplete: true,
  });

  // 19. Agent Outcome Closure — Daily 03:45 IST (22:15 UTC). Checks
  // accepted/adjusted compass_actions proposals for implicit follow-through.
  cronQueue.add('agentOutcomeClosure', {}, {
    repeat: { pattern: '15 22 * * *' },
    removeOnComplete: true,
  });

  // 20. Intervention Weekly Brief — Sunday 22:30 UTC (Monday 04:00 IST). Generates
  // weekly briefs for institution cohort intervention agent, ready before the
  // TPO's Monday morning.
  cronQueue.add('interventionWeeklyBrief', {}, {
    repeat: { pattern: '30 22 * * 0' },
    removeOnComplete: true,
  });

  // 21. Activation Daily Nudge — Daily 11:00 AM IST (5:30 AM UTC). Sends
  // daily re-activation nudges to invited students within reminder cap.
  cronQueue.add('activationDailyNudge', {}, {
    repeat: { pattern: '30 5 * * *' },
    removeOnComplete: true,
  });

  // Competition: Generate + activate daily challenges (and live events on eve days)
  // Daily midnight IST = 18:30 UTC previous day
  competitionQueue.add('generateAndActivateDaily', {}, {
    repeat: { pattern: '30 18 * * *' },
    removeOnComplete: true,
  });

  // Competition: Finalize daily rankings — Daily 00:30 IST (19:00 UTC prev day)
  competitionQueue.add('finalizeDailyRankings', {}, {
    repeat: { pattern: '0 19 * * *' },
    removeOnComplete: true,
  });

  // Competition: Finalize weekly leaderboard — Monday 00:30 IST (Sun 19:00 UTC)
  competitionQueue.add('finalizeWeeklyLeaderboard', {}, {
    repeat: { pattern: '0 19 * * 0' },
    removeOnComplete: true,
  });

  // Competition: Streak reminder — Daily 21:00 IST (15:30 UTC)
  competitionQueue.add('streakReminderNotification', {}, {
    repeat: { pattern: '30 15 * * *' },
    removeOnComplete: true,
  });

  // Competition: Live event reminder — Mon/Wed/Fri 19:30 IST (14:00 UTC)
  competitionQueue.add('liveEventReminder', {}, {
    repeat: { pattern: '0 14 * * 1,3,5' },
    removeOnComplete: true,
  });

  // Competition: Open live event lobby — Mon/Wed/Fri 19:55 IST (14:25 UTC)
  competitionQueue.add('openLiveEventLobby', {}, {
    repeat: { pattern: '25 14 * * 1,3,5' },
    removeOnComplete: true,
  });

  // Competition: Start live event — Mon/Wed/Fri 20:00 IST (14:30 UTC)
  competitionQueue.add('startLiveEvent', {}, {
    repeat: { pattern: '30 14 * * 1,3,5' },
    removeOnComplete: true,
  });

  // Competition: Safety net — complete stuck live events — Mon/Wed/Fri 20:20 IST (14:50 UTC)
  competitionQueue.add('completeLiveEventSafety', {}, {
    repeat: { pattern: '50 14 * * 1,3,5' },
    removeOnComplete: true,
  });

  const { Worker } = require('bullmq');
  new Worker('cronJobs', async (job) => {
    switch (job.name) {
      case 'weeklyReviewQuiz':
        await runWeeklyReviewQuiz();
        break;
      case 'retentionCheck':
        await runRetentionCheck();
        break;
      case 'quizExpiry':
        await runQuizExpiry();
        break;
      case 'reEngagement':
        await runReEngagement();
        break;
      case 'creatorTierCheck':
        await runCreatorTierCheck();
        break;
      case 'journeyAdvancement':
        await runJourneyAdvancement();
        break;
      case 'streakReset':
        await resetStaleStreaks();
        break;
      case 'accountDeletion':
        await runAccountDeletion();
        break;
      case 'flashcardReviewReminder':
        await runFlashcardReviewReminder();
        break;
      case 'recalibrationOffer':
        await require('./recalibrationOfferWorker').run();
        break;
      case 'adminQuestionDigest':
        await require('./adminDigestWorker').run();
        break;
      case 'validatorBackfill':
        await require('./validatorBackfillWorker').runBackfill({ batchSize: 200 });
        break;
      case 'mixpanelDailyDigest':
        await require('./mixpanelDailyDigestWorker').run();
        break;
      case 'diagnosticHealthCheck':
        await require('./diagnosticHealthCheckWorker').run();
        break;
      case 'weeklyAutoCalibration':
        await require('./weeklyAutoCalibrationWorker').runWeeklyAutoCalibration();
        break;
      case 'dailyTopGapQuizzes':
        await runDailyTopGapQuizzes();
        break;
      case 'cohortDirectoryHousekeeping':
        await require('./cohortDirectoryHousekeepingWorker').run();
        break;
      case 'agentDecisionExpiry': {
        const { expireStale } = require('../services/agentDecisionService');
        const r = await expireStale({ hours: Number(process.env.AGENT_DECISION_TTL_HOURS || 48) });
        console.log(`[cron] agentDecisionExpiry: ${r.expired} pending decisions marked ignored`);
        break;
      }
      case 'agentOutcomeClosure': {
        const { closeCompassActionOutcomes, closeInterviewFocusOutcomes } = require('../services/agentOutcomeClosureService');
        const compassResult = await closeCompassActionOutcomes({ olderThanHours: Number(process.env.AGENT_OUTCOME_CLOSURE_MIN_HOURS || 24) });
        const interviewFocusResult = await closeInterviewFocusOutcomes({ olderThanDays: Number(process.env.AGENT_OUTCOME_CLOSURE_INTERVIEW_FOCUS_DAYS || 7) });
        console.log(`[cron] agentOutcomeClosure: ${compassResult.closed} compass decisions closed, ${interviewFocusResult.closed} interview-focus closed`);
        break;
      }
      case 'interventionWeeklyBrief': {
        const { runWeekly } = require('../services/institution/interventionAgentService');
        const r = await runWeekly();
        console.log('[cron] interventionWeeklyBrief: ' + r.briefs + ' briefs recorded');
        break;
      }
      case 'activationDailyNudge': {
        const { runDaily } = require('../services/institution/activationAgentService');
        const r = await runDaily();
        console.log('[cron] activationDailyNudge: ' + r.reminded + ' reminders across ' + r.cohorts + ' cohorts');
        break;
      }
    }
  }, { connection });

  console.log('Cron jobs scheduled');
}

// --- Cron Handlers ---

async function runWeeklyReviewQuiz() {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Find users who consumed content this week
  const graphs = await ConsumptionGraph.find({
    lastUpdatedAt: { $gte: oneWeekAgo },
  }).select('userId topicNodes');

  for (const graph of graphs) {
    const recentTopics = graph.topicNodes
      .filter(n => n.lastConsumedAt && n.lastConsumedAt >= oneWeekAgo)
      .map(n => n.topic);

    if (recentTopics.length === 0) continue;

    // Use the most-consumed recent topic as the primary topic
    const primaryTopic = recentTopics[0];

    // Gather content IDs from recent topics
    const contentIds = graph.topicNodes
      .filter(n => recentTopics.includes(n.topic))
      .flatMap(n => n.contentIds.slice(-3))
      .map(id => id.toString());

    await quizGenerationQueue.add('generate', {
      userId: graph.userId.toString(),
      topic: primaryTopic,
      contentIds,
      type: 'weekly_checkpoint',  // Must match TRIGGER_TO_QUIZ_TYPE mapping
      triggerId: null,
      questionCount: 12,
    });

    console.log(`[CronJobs] Weekly review quiz queued for user ${graph.userId}, topic="${primaryTopic}", covering ${recentTopics.length} topics`);
  }
}

async function runRetentionCheck() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const profiles = await KnowledgeProfile.find({
    'topicMastery.lastAssessedAt': { $lte: sevenDaysAgo },
    'topicMastery.score': { $gte: 20 },
  });

  for (const profile of profiles) {
    const staleTopics = profile.topicMastery.filter(
      t => t.lastAssessedAt && t.lastAssessedAt <= sevenDaysAgo && t.score >= 20
    );

    for (const topic of staleTopics.slice(0, 2)) {
      const graph = await ConsumptionGraph.findOne({ userId: profile.userId });
      const node = graph?.topicNodes.find(n => n.topic === topic.topic);
      if (!node || node.contentIds.length === 0) continue;

      await quizGenerationQueue.add('generate', {
        userId: profile.userId.toString(),
        topic: topic.topic,
        contentIds: node.contentIds.slice(-5).map(id => id.toString()),
        type: 'retention_check',
        triggerId: null,
      });
    }
  }
}

async function runQuizExpiry() {
  await Quiz.updateMany(
    { status: { $in: ['ready', 'delivered'] }, expiresAt: { $lt: new Date() } },
    { status: 'expired' }
  );
}

async function runReEngagement() {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const inactiveUsers = await User.find({
    isActive: true,
    isBanned: false,
    lastLoginAt: { $lt: threeDaysAgo },
    fcmToken: { $exists: true, $ne: null },
  }).select('_id fcmToken');

  for (const user of inactiveUsers) {
    await notificationQueue.add('send', {
      userId: user._id,
      title: 'We miss you!',
      body: 'Your learning journey is waiting. Pick up where you left off!',
      data: { type: 're_engagement' },
    });
  }
}

async function runCreatorTierCheck() {
  // Check rising creators for promotion to core
  const risingCreators = await CreatorProfile.find({ tier: 'rising' }).populate('userId');

  for (const creator of risingCreators) {
    if (
      creator.stats.totalContent >= 20 &&
      creator.stats.averageRating >= 4.0
    ) {
      creator.tier = 'core';
      await creator.save();
    }
  }

  // Check core creators for promotion to anchor
  const coreCreators = await CreatorProfile.find({ tier: 'core' }).populate('userId');

  for (const creator of coreCreators) {
    if (
      creator.stats.totalContent >= 50 &&
      creator.stats.averageRating >= 4.5 &&
      creator.stats.totalFollowers >= 1000
    ) {
      creator.tier = 'anchor';
      await creator.save();
    }
  }
}

async function runJourneyAdvancement() {
  const activeJourneys = await Journey.find({ status: 'active' });

  for (const journey of activeJourneys) {
    const currentWeekPlan = journey.weeklyPlans.find(
      w => w.weekNumber === journey.currentWeek
    );

    if (!currentWeekPlan) continue;

    // Check if current week has ended
    if (currentWeekPlan.endDate && currentWeekPlan.endDate <= new Date()) {
      currentWeekPlan.status = 'completed';

      // Advance to next week
      const nextWeek = journey.weeklyPlans.find(
        w => w.weekNumber === journey.currentWeek + 1
      );

      if (nextWeek) {
        journey.currentWeek += 1;
        nextWeek.status = 'active';
        nextWeek.startDate = new Date();
        nextWeek.endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      }

      // Check phase advancement
      const currentPhase = journey.phases[journey.currentPhaseIndex];
      if (currentPhase && currentPhase.endDate && currentPhase.endDate <= new Date()) {
        currentPhase.status = 'completed';
        if (journey.currentPhaseIndex < journey.phases.length - 1) {
          journey.currentPhaseIndex += 1;
          journey.phases[journey.currentPhaseIndex].status = 'active';
          journey.phases[journey.currentPhaseIndex].startDate = new Date();
        }
      }

      // Check milestones for overdue
      for (const milestone of journey.milestones) {
        if (
          milestone.status === 'upcoming' &&
          milestone.scheduledDate &&
          milestone.scheduledDate <= new Date()
        ) {
          milestone.status = 'overdue';
        }
      }

      await journey.save();
    }
  }
}

async function runAccountDeletion() {
  const deactivationService = require('../services/deactivationService');

  // Send 7-day and 1-day deletion reminders
  try {
    await deactivationService.sendDeletionReminders();
  } catch (err) {
    console.error('[Cron] Deletion reminders failed:', err.message);
  }

  // Permanently delete accounts past 30-day grace period
  try {
    const count = await deactivationService.permanentlyDeleteExpiredAccounts();
    if (count > 0) {
      console.log(`[Cron] Permanently deleted ${count} expired account(s)`);
    }
  } catch (err) {
    console.error('[Cron] Permanent deletion failed:', err.message);
  }
}

// --- Flashcard Spaced Repetition Reminders ---
async function runFlashcardReviewReminder() {
  const FlashcardSet = require('../models/FlashcardSet');

  // Find flashcard sets that are due for review
  // Spaced repetition schedule:
  // - Never studied → remind after 1 day
  // - Studied 1x → remind after 2 days
  // - Studied 2x → remind after 4 days
  // - Studied 3x+ → remind after 7 days
  const now = new Date();
  const sets = await FlashcardSet.find({ status: 'ready' }).lean();

  for (const set of sets) {
    if (!set.lastStudiedAt && set.createdAt) {
      // Never studied — remind 1 day after creation
      const dayAfter = new Date(set.createdAt.getTime() + 24 * 60 * 60 * 1000);
      if (now >= dayAfter) {
        await sendFlashcardReminder(set, 'Time to study your flashcards!');
      }
    } else if (set.lastStudiedAt) {
      const studied = set.timesStudied || 0;
      const daysUntilReview = studied <= 1 ? 2 : studied <= 2 ? 4 : 7;
      const dueDate = new Date(set.lastStudiedAt.getTime() + daysUntilReview * 24 * 60 * 60 * 1000);
      if (now >= dueDate) {
        const mastery = set.totalCards > 0 ? Math.round((set.masteredCount / set.totalCards) * 100) : 0;
        if (mastery < 100) {
          await sendFlashcardReminder(set, `Review due — ${mastery}% mastered`);
        }
      }
    }
  }
}

async function sendFlashcardReminder(set, message) {
  try {
    await notificationQueue.add('send', {
      userId: set.userId.toString(),
      title: 'Flashcard Review Due',
      body: `${set.title}: ${message}`,
      data: { type: 'flashcard_review', flashcardSetId: set._id.toString() },
    });
  } catch {}
}

/**
 * Daily seed: 3 ten-question quizzes per active user on their weakest topics.
 *
 * The user kept hitting an empty "Pending" — we had no continuous source of
 * fresh quizzes. This cron fires once per day (00:15 IST) and:
 *   1. Walks active V2 users with a KnowledgeProfile.
 *   2. Picks the 3 weakest topics (score asc) that the user has actually been
 *      assessed on (quizzesTaken >= 1) — no quizzes on topics we have no
 *      signal about yet.
 *   3. Skips topics that already have a pending daily quiz from the last 24h
 *      (dedup, so we don't generate the same thing twice on a re-run).
 *   4. Caps total pending daily quizzes per user at 3 so we never spam.
 */
async function runDailyTopGapQuizzes() {
  const DAILY_CAP = 3;
  const QUESTIONS_PER_QUIZ = 10;
  const NOW = new Date();
  const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

  // Active V2 users only — keeps token cost bounded to the active cohort.
  const users = await User.find({
    isActive: true, isBanned: false, v2OptedIn: true,
  }).select('_id').lean();

  let queued = 0;
  for (const u of users) {
    try {
      const profile = await KnowledgeProfile.findOne({ userId: u._id }).lean();
      if (!profile?.topicMastery?.length) continue;

      // How many active daily quizzes does the user already have?
      const existingDaily = await Quiz.countDocuments({
        userId: u._id,
        type: 'daily_top_gap',
        status: { $in: ['ready', 'delivered'] },
        expiresAt: { $gt: NOW },
      });
      const slots = Math.max(0, DAILY_CAP - existingDaily);
      if (slots === 0) continue;

      // Topics already seeded in the last day — skip.
      const recentDailyTopics = await Quiz.distinct('topic', {
        userId: u._id,
        type: 'daily_top_gap',
        createdAt: { $gte: yesterday },
      });
      const seen = new Set(recentDailyTopics);

      const weakest = (profile.topicMastery || [])
        .filter(t => (t.quizzesTaken || 0) >= 1 && !seen.has(t.topic))
        .sort((a, b) => (a.score || 0) - (b.score || 0))
        .slice(0, slots);

      // After picking from existing mastery, if slots remain, seed from
      // topicsOfInterest — topics the user added but has never been quizzed on.
      // This is the "user told us they care, but we have no data yet" case.
      const remaining = slots - weakest.length;
      let interestSeeds = [];
      if (remaining > 0) {
        const UserObjective = require('../models/UserObjective');
        const objective = await UserObjective.findOne({
          userId: u._id,
          status: 'active', isPrimary: true,
        }).select('topicsOfInterest').lean();
        const interestTopics = (objective?.topicsOfInterest || []).map(t => t.toString().toLowerCase());
        const masteryTopics = new Set((profile.topicMastery || []).map(t => t.topic.toLowerCase()));
        interestSeeds = interestTopics
          .filter(t => t && !seen.has(t) && !masteryTopics.has(t))
          .slice(0, remaining)
          .map(topic => ({ topic, _isSeed: true }));
      }

      const combined = [...weakest, ...interestSeeds];
      console.log(`[DailyTopGap] user ${u._id}: ${weakest.length} from mastery + ${interestSeeds.length} from interests`);

      for (const t of combined) {
        await quizGenerationQueue.add('generate', {
          userId: u._id.toString(),
          topic: t.topic,
          contentIds: [],
          type: 'daily_top_gap',
          questionCount: QUESTIONS_PER_QUIZ,
          triggerId: null,
          suppressNotification: true,  // batch — one push later, not per quiz
        }, { attempts: 2, backoff: { type: 'exponential', delay: 10000 } });
        queued++;
      }

      // Single batch notification per user, not one per quiz.
      if (combined.length > 0) {
        await notificationQueue.add('send', {
          userId: u._id,
          title: 'Today\'s quizzes are ready',
          body: `${combined.length} new ${combined.length === 1 ? 'quiz' : 'quizzes'} ready: ${combined.map(w => w.topic).join(', ')}.`,
          data: { type: 'daily_top_gap_ready' },
        });
      }
    } catch (err) {
      console.warn(`[DailyTopGap] user ${u._id} failed:`, err.message);
    }
  }
  console.log(`[DailyTopGap] queued ${queued} quizzes across ${users.length} users`);
}

/**
 * Same logic as the cron but for a single user. Exposed so the API can
 * "ensure" a user has their daily quizzes when they open Quiz Home, instead
 * of forcing them to wait for the next midnight tick.
 */
async function ensureDailyTopGapQuizzesForUser(userId) {
  const DAILY_CAP = 3;
  const QUESTIONS_PER_QUIZ = 10;
  const NOW = new Date();
  const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

  const profile = await KnowledgeProfile.findOne({ userId }).lean();
  if (!profile?.topicMastery?.length) return { queued: 0, reason: 'no_mastery' };

  const existingDaily = await Quiz.countDocuments({
    userId, type: 'daily_top_gap',
    status: { $in: ['ready', 'delivered'] },
    expiresAt: { $gt: NOW },
  });
  const slots = Math.max(0, DAILY_CAP - existingDaily);
  if (slots === 0) return { queued: 0, reason: 'already_at_cap' };

  const recentDailyTopics = await Quiz.distinct('topic', {
    userId, type: 'daily_top_gap',
    createdAt: { $gte: yesterday },
  });
  const seen = new Set(recentDailyTopics);

  const weakest = (profile.topicMastery || [])
    .filter(t => (t.quizzesTaken || 0) >= 1 && !seen.has(t.topic))
    .sort((a, b) => (a.score || 0) - (b.score || 0))
    .slice(0, slots);

  // After picking from existing mastery, if slots remain, seed from
  // topicsOfInterest — topics the user added but has never been quizzed on.
  // This is the "user told us they care, but we have no data yet" case.
  const remaining = slots - weakest.length;
  let interestSeeds = [];
  if (remaining > 0) {
    const UserObjective = require('../models/UserObjective');
    const objective = await UserObjective.findOne({
      userId,
      status: 'active', isPrimary: true,
    }).select('topicsOfInterest').lean();
    const interestTopics = (objective?.topicsOfInterest || []).map(t => t.toString().toLowerCase());
    const masteryTopics = new Set((profile.topicMastery || []).map(t => t.topic.toLowerCase()));
    interestSeeds = interestTopics
      .filter(t => t && !seen.has(t) && !masteryTopics.has(t))
      .slice(0, remaining)
      .map(topic => ({ topic, _isSeed: true }));
  }

  const combined = [...weakest, ...interestSeeds];
  console.log(`[DailyTopGap] user ${userId}: ${weakest.length} from mastery + ${interestSeeds.length} from interests`);

  for (const t of combined) {
    await quizGenerationQueue.add('generate', {
      userId: userId.toString(),
      topic: t.topic,
      contentIds: [],
      type: 'daily_top_gap',
      questionCount: QUESTIONS_PER_QUIZ,
      triggerId: null,
      suppressNotification: true,
    }, { attempts: 2, backoff: { type: 'exponential', delay: 10000 } });
  }
  return { queued: combined.length, topics: combined.map(w => w.topic) };
}

module.exports = { startCronJobs, runDailyTopGapQuizzes, ensureDailyTopGapQuizzesForUser };
