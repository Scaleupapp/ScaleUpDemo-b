const { Queue } = require('bullmq');
const Redis = require('ioredis');
const User = require('../models/User');
const Quiz = require('../models/Quiz');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const Journey = require('../models/Journey');
const CreatorProfile = require('../models/CreatorProfile');
const Content = require('../models/Content');
const { quizGenerationQueue, notificationQueue } = require('../config/queue');
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

    // Gather content IDs from recent topics
    const contentIds = graph.topicNodes
      .filter(n => recentTopics.includes(n.topic))
      .flatMap(n => n.contentIds.slice(-3));

    await quizGenerationQueue.add('generate', {
      userId: graph.userId,
      topic: recentTopics.join(', '),
      contentIds,
      type: 'weekly_review',
      triggerId: null,
    });
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
        userId: profile.userId,
        topic: topic.topic,
        contentIds: node.contentIds.slice(-5),
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

module.exports = { startCronJobs };
