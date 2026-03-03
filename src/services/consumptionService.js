const mongoose = require('mongoose');
const Content = require('../models/Content');
const ContentProgress = require('../models/ContentProgress');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const { paginationMeta } = require('../utils/pagination');
const { updateStreak } = require('./streakService');

class ConsumptionService {

  async updateProgress(userId, contentId, { currentPosition, timeSpent, totalDuration: clientDuration }) {
    const content = await Content.findById(contentId);
    const totalDuration = clientDuration || content?.duration || 100;
    // Cap per-request timeSpent to 5 minutes to prevent bogus accumulation
    const safeTimeSpent = Math.min(Math.max(Number(timeSpent) || 0, 0), 300);

    const progress = await ContentProgress.findOneAndUpdate(
      { userId, contentId },
      {
        $set: {
          currentPosition, totalDuration,
          percentageCompleted: Math.min(100, Math.round((currentPosition / totalDuration) * 100)),
          lastSessionAt: new Date(),
        },
        $inc: { totalTimeSpent: safeTimeSpent },
        $setOnInsert: { firstViewedAt: new Date(), sessionCount: 0 },
      },
      { upsert: true, new: true }
    );

    // Cap totalTimeSpent at 2x content duration to prevent runaway accumulation
    const maxTime = totalDuration * 2;
    if (progress.totalTimeSpent > maxTime) {
      progress.totalTimeSpent = maxTime;
    }

    if (progress.sessionCount === 0) {
      progress.sessionCount = 1;
      await Content.findByIdAndUpdate(contentId, { $inc: { viewCount: 1 } });
    }

    await progress.save();
    return progress;
  }

  async markCompleted(userId, contentId) {
    const progress = await ContentProgress.findOneAndUpdate(
      { userId, contentId },
      { isCompleted: true, completedAt: new Date(), percentageCompleted: 100 },
      { new: true }
    );

    await this.updateConsumptionGraph(userId, contentId);

    // Lazy require to avoid circular dependency
    const quizTriggerService = require('./quizTriggerService');
    await quizTriggerService.checkTriggers(userId, contentId);

    // Update journey assignment if this content is part of an active journey
    try {
      const Journey = require('../models/Journey');
      const journey = await Journey.findOne({ userId, status: 'active' });
      if (journey) {
        let updated = false;
        for (const week of journey.weeklyPlans) {
          for (const assignment of week.dailyAssignments) {
            if (assignment.contentIds && assignment.contentIds.map(id => id.toString()).includes(contentId.toString())) {
              if (!assignment.completed) {
                // Check if all content in this assignment has been completed
                const allContentProgress = await ContentProgress.find({
                  userId,
                  contentId: { $in: assignment.contentIds },
                  isCompleted: true,
                });
                if (allContentProgress.length >= assignment.contentIds.length) {
                  assignment.completed = true;
                  assignment.completedAt = new Date();
                  updated = true;
                }
              }
            }
          }
        }
        if (updated) {
          const completedAssignments = journey.weeklyPlans.reduce((sum, w) =>
            sum + w.dailyAssignments.filter(d => d.completed).length, 0);
          const totalAssignments = journey.weeklyPlans.reduce((sum, w) =>
            sum + w.dailyAssignments.length, 0);
          journey.progress.contentConsumed = completedAssignments;
          journey.progress.overallPercentage = Math.round((completedAssignments / Math.max(totalAssignments, 1)) * 100);
          await journey.save();
        }
      }
    } catch (e) {
      console.error('[consumptionService] Journey update error:', e.message);
    }

    // Update learning streak
    try {
      await updateStreak(userId);
    } catch (e) {
      console.error('[consumptionService] Streak update error:', e.message);
    }

    return progress;
  }

  async updateConsumptionGraph(userId, contentId) {
    const content = await Content.findById(contentId);
    if (!content) return;

    let graph = await ConsumptionGraph.findOne({ userId });
    if (!graph) {
      graph = await ConsumptionGraph.create({ userId, topicNodes: [], topicEdges: [] });
    }

    for (const topic of content.topics) {
      let node = graph.topicNodes.find(n => n.topic === topic);
      if (!node) {
        graph.topicNodes.push({
          topic, contentConsumed: 1, lastConsumedAt: new Date(), contentIds: [contentId],
        });
      } else {
        node.contentConsumed += 1;
        node.lastConsumedAt = new Date();
        if (!node.contentIds.map(id => id.toString()).includes(contentId.toString())) {
          node.contentIds.push(contentId);
        }
      }
    }

    if (content.topics.length > 1) {
      for (let i = 0; i < content.topics.length; i++) {
        for (let j = i + 1; j < content.topics.length; j++) {
          const [a, b] = [content.topics[i], content.topics[j]].sort();
          let edge = graph.topicEdges.find(e => e.topicA === a && e.topicB === b);
          if (!edge) {
            graph.topicEdges.push({ topicA: a, topicB: b, strength: 1 });
          } else {
            edge.strength += 1;
          }
        }
      }
    }

    graph.totalContentConsumed += 1;
    graph.lastUpdatedAt = new Date();
    graph.dominantTopics = graph.topicNodes
      .sort((a, b) => b.contentConsumed - a.contentConsumed)
      .slice(0, 3)
      .map(n => n.topic);

    await graph.save();
  }

  async getHistory(userId, { page = 1, limit = 20 }) {
    const skip = (page - 1) * limit;
    const filter = { userId, percentageCompleted: { $gt: 0 } };
    const [items, total] = await Promise.all([
      ContentProgress.find(filter)
        .sort({ lastSessionAt: -1 }).skip(skip).limit(limit)
        .populate('contentId', 'title contentType thumbnailURL domain topics duration sourceType youtubeVideoId creatorId')
        .populate({ path: 'contentId', populate: { path: 'creatorId', select: 'firstName lastName username profilePicture' } }),
      ContentProgress.countDocuments(filter),
    ]);
    return { items, pagination: paginationMeta(total, page, limit) };
  }

  async getStats(userId) {
    const [graph, timeAgg] = await Promise.all([
      ConsumptionGraph.findOne({ userId }),
      ContentProgress.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(userId) } },
        { $group: { _id: null, total: { $sum: '$totalTimeSpent' } } },
      ]),
    ]);
    const totalTimeSpent = timeAgg.length > 0 ? (timeAgg[0].total || 0) : 0;
    return {
      totalContentConsumed: graph?.totalContentConsumed || 0,
      totalTimeSpent,
      dominantTopics: graph?.dominantTopics || [],
      topicCount: graph?.topicNodes?.length || 0,
      topicBreakdown: (graph?.topicNodes || []).map(n => ({
        topic: n.topic, contentConsumed: n.contentConsumed, affinityScore: n.affinityScore,
      })),
    };
  }

  async getActivityHeatmap(userId, days = 90) {
    const startDate = new Date();
    startDate.setUTCDate(startDate.getUTCDate() - days);
    startDate.setUTCHours(0, 0, 0, 0);

    const pipeline = [
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          isCompleted: true,
          completedAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', count: 1 } },
    ];

    return ContentProgress.aggregate(pipeline);
  }

  async getTimeline(userId, limit = 20) {
    const QuizAttempt = require('../models/QuizAttempt');
    const Journey = require('../models/Journey');

    const [contentEvents, quizEvents, journey] = await Promise.all([
      ContentProgress.find({ userId, isCompleted: true })
        .sort({ completedAt: -1 })
        .limit(limit)
        .populate('contentId', 'title contentType thumbnailURL topics duration')
        .lean(),
      QuizAttempt.find({ userId, status: 'completed' })
        .sort({ completedAt: -1 })
        .limit(limit)
        .lean(),
      Journey.findOne({ userId, status: 'active' })
        .select('milestones')
        .lean(),
    ]);

    const events = [];

    for (const cp of contentEvents) {
      if (!cp.completedAt || !cp.contentId) continue;
      events.push({
        type: 'content_completed',
        title: cp.contentId.title || 'Content Completed',
        subtitle: cp.contentId.topics?.join(', ') || '',
        date: cp.completedAt,
        metadata: {
          contentType: cp.contentId.contentType,
          duration: cp.contentId.duration,
          thumbnailURL: cp.contentId.thumbnailURL,
        },
      });
    }

    for (const qa of quizEvents) {
      if (!qa.completedAt) continue;
      events.push({
        type: 'quiz_completed',
        title: qa.title || 'Quiz Completed',
        subtitle: `Score: ${qa.score?.percentage ?? 0}%`,
        date: qa.completedAt,
        metadata: {
          topic: qa.topic,
          percentage: qa.score?.percentage,
        },
      });
    }

    if (journey?.milestones) {
      for (const ms of journey.milestones) {
        if (ms.status === 'completed' && ms.completedAt) {
          events.push({
            type: 'milestone_achieved',
            title: ms.title,
            subtitle: (ms.type || 'milestone').replace(/_/g, ' '),
            date: ms.completedAt,
            metadata: { milestoneType: ms.type },
          });
        }
      }
    }

    events.sort((a, b) => new Date(b.date) - new Date(a.date));
    return events.slice(0, limit);
  }
}

module.exports = new ConsumptionService();
