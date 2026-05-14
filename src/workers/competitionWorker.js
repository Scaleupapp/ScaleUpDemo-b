// src/workers/competitionWorker.js
const { Worker } = require('bullmq');
const Redis = require('ioredis');
const challengeGenerationService = require('../services/challengeGenerationService');
const competitionService = require('../services/competitionService');
const liveEventService = require('../services/liveEventService');
const LiveEvent = require('../models/LiveEvent');
const ChallengeAttempt = require('../models/ChallengeAttempt');
const DailyChallenge = require('../models/DailyChallenge');
const WeeklyLeaderboard = require('../models/WeeklyLeaderboard');
const CompetitionProfile = require('../models/CompetitionProfile');
const { notificationQueue } = require('../config/queue');

const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const competitionWorker = new Worker('competition', async (job) => {
  console.log(`[CompetitionWorker] Processing job: ${job.name}`);

  switch (job.name) {
    case 'generateAndActivateDaily': {
      const result = await challengeGenerationService.generateAndActivateDaily();

      // Send notifications for activated daily challenges
      const UserObjective = require('../models/UserObjective');
      const normalizeTopic = require('../utils/normalizeTopic');
      const challengeGenService = require('../services/challengeGenerationService');
      for (const { topic, challengeId } of result.daily) {
        const allObjectives = await UserObjective.find(
          { status: 'active' },
          { objectiveType: 1, specifics: 1, topicsOfInterest: 1, userId: 1 }
        ).lean();
        const matchingUserIds = allObjectives
          .filter(obj => normalizeTopic(challengeGenService._deriveObjectiveTopic(obj)) === topic)
          .map(obj => obj.userId);
        for (const userId of matchingUserIds) {
          await notificationQueue.add('send', {
            userId: userId.toString(),
            title: "Today's Challenge is Live! ⚡",
            body: `Test your ${topic} skills — compete with other learners!`,
            data: { type: 'challenge_live', challengeId: challengeId.toString() },
          });
        }
      }

      if (result.errors.length > 0) {
        console.error('[CompetitionWorker] Generation errors:', JSON.stringify(result.errors));
        // Log is sufficient for now — Slack alerting deferred to future iteration
      }

      return result;
    }

    case 'finalizeDailyRankings': {
      const yesterday = new Date(competitionService._todayIST().getTime() - 24 * 60 * 60 * 1000);
      const challenges = await DailyChallenge.find({ date: yesterday, status: 'closed' });

      for (const challenge of challenges) {
        const attempts = await ChallengeAttempt.find({ challengeId: challenge._id, completedAt: { $ne: null } });
        if (attempts.length < 3) continue;

        const times = attempts.map(a => a.timeTaken || 0).filter(t => t > 0);
        if (times.length === 0) continue;
        const sorted = [...times].sort((a, b) => a - b);
        const medianTime = sorted[Math.floor(sorted.length / 2)];

        for (const attempt of attempts) {
          const userTime = attempt.timeTaken || 0;
          if (userTime <= 0 || userTime >= medianTime) continue;

          const speedFactor = Math.max(0, (medianTime - userTime) / medianTime);
          const baseScore = attempt.handicappedScore;
          const speedBonus = baseScore * 0.10 * speedFactor;

          attempt.handicappedScore += speedBonus;
          await attempt.save();

          await competitionService._updateWeeklyLeaderboard(
            attempt.userId, challenge.topic, speedBonus
          );
        }
      }
      return { processed: challenges.length };
    }

    case 'finalizeWeeklyLeaderboard': {
      const prevWeekStart = new Date(competitionService._currentWeekStartIST().getTime() - 7 * 24 * 60 * 60 * 1000);
      const boards = await WeeklyLeaderboard.find({ weekStart: prevWeekStart, finalized: false });

      for (const board of boards) {
        board.entries.sort((a, b) => b.totalHandicappedScore - a.totalHandicappedScore);
        board.entries.forEach((entry, idx) => {
          entry.rank = idx + 1;
          entry.percentile = Math.round(((board.entries.length - idx) / board.entries.length) * 100);
        });
        board.finalized = true;
        await board.save();

        if (board.entries.length > 0 && board.topic !== 'global') {
          const winner = board.entries[0];
          await CompetitionProfile.findOneAndUpdate(
            { userId: winner.userId },
            { $push: { titlesEarned: { title: `${board.topic} Weekly Champion`, earnedAt: new Date(), topic: board.topic } } },
            { upsert: true }
          );
        }

        for (const entry of board.entries.slice(0, 3)) {
          await notificationQueue.add('send', {
            userId: entry.userId,
            title: `You finished #${entry.rank} this week! 🏆`,
            body: `Top ${entry.percentile}% in ${board.topic} — ${entry.challengesCompleted}/7 challenges`,
            data: { type: 'weekly_results', topic: board.topic },
          });
        }
      }
      return { finalized: boards.length };
    }

    case 'streakReminderNotification': {
      const today = competitionService._todayIST();
      const challenges = await DailyChallenge.find({ date: today, status: 'active' });
      const challengeIds = challenges.map(c => c._id);

      const profiles = await CompetitionProfile.find({ currentChallengeStreak: { $gte: 1 } });

      // v2 anti-thesis cleanup: skip streak-panic notifications for v2 users.
      // Gated by the same kill switch as the v2 API — when V2_API_ENABLED=false
      // this whole behavior reverts and v1 users (everyone) get the reminder.
      const v2Enabled = process.env.V2_API_ENABLED !== 'false';
      let v2UserIds = new Set();
      if (v2Enabled) {
        const User = require('../models/User');
        v2UserIds = new Set(
          (await User.find({
            _id: { $in: profiles.map(p => p.userId) },
            v2OptedIn: true,
          }).select('_id').lean()).map(u => String(u._id))
        );
      }

      let suppressed = 0;
      for (const profile of profiles) {
        if (v2UserIds.has(String(profile.userId))) {
          suppressed += 1;
          continue;
        }
        const todayAttempt = await ChallengeAttempt.findOne({
          userId: profile.userId,
          challengeId: { $in: challengeIds },
          completedAt: { $ne: null },
        });
        if (!todayAttempt) {
          await notificationQueue.add('send', {
            userId: profile.userId,
            title: "Don't lose your streak! 🔥",
            body: `${profile.currentChallengeStreak} days straight — today's challenge is waiting`,
            data: { type: 'streak_reminder' },
          });
        }
      }
      return { checked: profiles.length, suppressedV2: suppressed };
    }

    case 'openLiveEventLobby': {
      const now = new Date();
      const fiveMinFromNow = new Date(now.getTime() + 5 * 60 * 1000);
      const events = await LiveEvent.find({
        scheduledAt: { $lte: fiveMinFromNow, $gte: now },
        status: 'scheduled',
      });
      for (const event of events) {
        event.status = 'lobby';
        await event.save();
      }
      return { opened: events.length };
    }

    case 'startLiveEvent': {
      const events = await LiveEvent.find({ status: 'lobby' });
      for (const event of events) {
        if (new Date() >= event.scheduledAt) {
          event.status = 'live';
          event.startedAt = new Date();
          await event.save();

          // Fixed 20-minute duration for all live events
          const { competitionQueue } = require('../config/queue');
          await competitionQueue.add('completeLiveEvent', { eventId: event._id.toString() }, {
            delay: 20 * 60 * 1000,
            removeOnComplete: true,
          });
        }
      }
      return { started: events.length };
    }

    case 'completeLiveEvent': {
      const event = await liveEventService.completeLiveEvent(job.data.eventId);
      for (const entry of event.leaderboard.slice(0, 3)) {
        await notificationQueue.add('send', {
          userId: entry.userId,
          title: `Live Event Results! 🏆`,
          body: `You finished #${entry.rank} out of ${event.leaderboard.length} in ${event.topic}`,
          data: { type: 'live_event_results', eventId: event._id.toString() },
        });
      }
      return { completed: event._id };
    }

    case 'completeLiveEventSafety': {
      const stuckEvents = await LiveEvent.find({ status: 'live' });
      let completed = 0;
      for (const event of stuckEvents) {
        try {
          await liveEventService.completeLiveEvent(event._id.toString());
          for (const entry of event.leaderboard?.slice(0, 3) || []) {
            await notificationQueue.add('send', {
              userId: entry.userId,
              title: 'Live Event Results! 🏆',
              body: `You finished #${entry.rank} out of ${event.leaderboard.length} in ${event.topic}`,
              data: { type: 'live_event_results', eventId: event._id.toString() },
            });
          }
          completed++;
        } catch (err) {
          console.error(`[CompetitionWorker] Safety complete failed for ${event._id}:`, err.message);
        }
      }
      return { completed };
    }

    case 'liveEventReminder': {
      const events = await LiveEvent.find({
        status: 'scheduled',
        scheduledAt: {
          $gte: new Date(),
          $lte: new Date(Date.now() + 35 * 60 * 1000),
        },
      });
      const UserObjective2 = require('../models/UserObjective');
      const normalizeTopic2 = require('../utils/normalizeTopic');
      const challengeGenService2 = require('../services/challengeGenerationService');
      for (const event of events) {
        const allObjectives = await UserObjective2.find(
          { status: 'active' },
          { objectiveType: 1, specifics: 1, topicsOfInterest: 1, userId: 1 }
        ).lean();
        const matchingUserIds = allObjectives
          .filter(obj => normalizeTopic2(challengeGenService2._deriveObjectiveTopic(obj)) === event.topic)
          .map(obj => obj.userId);
        for (const userId of matchingUserIds) {
          await notificationQueue.add('send', {
            userId: userId.toString(),
            title: 'Live Event Tonight! 🎯',
            body: `${event.topic} starts at 8 PM — don't miss it!`,
            data: { type: 'live_event_reminder', eventId: event._id.toString() },
          });
        }
      }
      return { reminded: events.length };
    }

    default:
      console.warn(`[CompetitionWorker] Unknown job: ${job.name}`);
  }
}, { connection, concurrency: 3 });

competitionWorker.on('failed', (job, err) => {
  console.error(`[CompetitionWorker] Job ${job.name} failed:`, err.message);
});

module.exports = competitionWorker;
