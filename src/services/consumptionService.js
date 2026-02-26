const Content = require('../models/Content');
const ContentProgress = require('../models/ContentProgress');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const { paginationMeta } = require('../utils/pagination');

class ConsumptionService {

  async updateProgress(userId, contentId, { currentPosition, timeSpent, totalDuration: clientDuration }) {
    const content = await Content.findById(contentId);
    const totalDuration = clientDuration || content?.duration || 100;
    const safeTimeSpent = Number(timeSpent) || 0;

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

    if (progress.sessionCount === 0) {
      progress.sessionCount = 1;
      await progress.save();
      await Content.findByIdAndUpdate(contentId, { $inc: { viewCount: 1 } });
    }

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
    const graph = await ConsumptionGraph.findOne({ userId });
    return {
      totalContentConsumed: graph?.totalContentConsumed || 0,
      totalTimeSpent: graph?.totalTimeSpent || 0,
      dominantTopics: graph?.dominantTopics || [],
      topicCount: graph?.topicNodes?.length || 0,
      topicBreakdown: (graph?.topicNodes || []).map(n => ({
        topic: n.topic, contentConsumed: n.contentConsumed, affinityScore: n.affinityScore,
      })),
    };
  }
}

module.exports = new ConsumptionService();
