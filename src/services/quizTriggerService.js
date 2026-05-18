const QuizTrigger = require('../models/QuizTrigger');
const Quiz = require('../models/Quiz');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const Content = require('../models/Content');
const { quizGenerationQueue } = require('../config/queue');

class QuizTriggerService {

  /**
   * Called after a user completes a content piece.
   * Checks if a topic_threshold trigger should fire.
   * Rule: If user has consumed 3+ content items on the same topic, generate a quiz.
   */
  async checkTriggers(userId, contentId) {
    const content = await Content.findById(contentId).lean();
    if (!content || !content.topics || content.topics.length === 0) return;

    const graph = await ConsumptionGraph.findOne({ userId });
    if (!graph) return;

    for (const topic of content.topics) {
      const node = graph.topicNodes.find(n => n.topic === topic);
      if (!node || node.contentConsumed < 3) continue;

      // Check if a trigger already exists recently for this topic (within last 24h)
      const recentTrigger = await QuizTrigger.findOne({
        userId,
        topic,
        triggerType: 'topic_threshold',
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });
      if (recentTrigger) continue;

      // Create the trigger
      const trigger = await QuizTrigger.create({
        userId,
        triggerType: 'topic_threshold',
        topic,
        sourceContentIds: node.contentIds.slice(-5),
        status: 'pending',
      });

      // Queue quiz generation
      await quizGenerationQueue.add('generate', {
        triggerId: trigger._id.toString(),
        userId: userId.toString(),
        topic,
        contentIds: node.contentIds.slice(-5).map(id => id.toString()),
        type: 'topic_threshold',
      }, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
      });

      trigger.status = 'queued';
      await trigger.save();
    }
  }

  /**
   * On-demand quiz request from the user.
   */
  async triggerOnDemand(userId, { topic, contentIds, questionCount, assessmentType, objectiveId, isSkillAssessment, noObjective, weekNumber, source }) {
    // Validate and cap question count (1-20, default decided by generation service)
    const validatedCount = questionCount ? Math.min(Math.max(Math.round(Number(questionCount)), 1), 20) : undefined;

    // If no contentIds provided, grab from consumption graph
    let resolvedContentIds = contentIds;
    if (!resolvedContentIds || resolvedContentIds.length === 0) {
      const graph = await ConsumptionGraph.findOne({ userId });
      const node = graph?.topicNodes.find(n => n.topic === topic);
      resolvedContentIds = node?.contentIds.slice(-5).map(id => id.toString()) || [];
    }

    if (resolvedContentIds.length === 0) {
      // Fallback: find published content on this topic
      const published = await Content.find({ status: 'published', topics: topic })
        .sort({ 'aiData.qualityScore': -1 }).limit(5).select('_id');
      resolvedContentIds = published.map(c => c._id.toString());
    }

    const trigger = await QuizTrigger.create({
      userId,
      triggerType: 'on_demand',
      topic,
      sourceContentIds: resolvedContentIds,
      status: 'pending',
    });

    await quizGenerationQueue.add('generate', {
      triggerId: trigger._id.toString(),
      userId: userId.toString(),
      topic,
      contentIds: resolvedContentIds,
      type: 'on_demand',
      questionCount: validatedCount,
      assessmentType: assessmentType || undefined,
      objectiveId: objectiveId || undefined,
      isSkillAssessment: isSkillAssessment || false,
      noObjective: noObjective === true,
      // Plan-context fields — propagated through so generateQuiz can seed
      // per-week variants and use a plan-aware expiresAt instead of 7d.
      weekNumber: (weekNumber != null) ? Number(weekNumber) : undefined,
      source: source || undefined,
    }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 10000 },
    });

    trigger.status = 'queued';
    await trigger.save();
    return trigger;
  }

  /**
   * Weekly review quiz (called from cronJobs).
   */
  async triggerWeeklyReview(userId, topic, contentIds) {
    const trigger = await QuizTrigger.create({
      userId,
      triggerType: 'weekly_checkpoint',
      topic,
      sourceContentIds: contentIds,
      status: 'pending',
    });

    await quizGenerationQueue.add('generate', {
      triggerId: trigger._id.toString(),
      userId: userId.toString(),
      topic,
      contentIds: contentIds.map(id => id.toString()),
      type: 'weekly_review',
    });

    trigger.status = 'queued';
    await trigger.save();
    return trigger;
  }

  /**
   * Auto-trigger a skill assessment quiz for a specific competency.
   * Called after objective analysis completes.
   */
  async triggerSkillAssessment(userId, { competencyName, assessmentType, objectiveId, weight }) {
    // Dedup: check if a competency_assessment already exists for this user+competency+objective
    const existing = await Quiz.findOne({
      userId,
      type: 'competency_assessment',
      topic: competencyName,
      objectiveId,
      status: { $in: ['ready', 'delivered', 'in_progress'] },
    });
    if (existing) {
      console.log(`[QuizTrigger] Skill assessment already exists for "${competencyName}", skipping`);
      return null;
    }

    // Question count by weight
    const questionCount = weight >= 8 ? 10 : weight >= 5 ? 7 : 5;

    const trigger = await QuizTrigger.create({
      userId,
      triggerType: 'on_demand',
      topic: competencyName,
      sourceContentIds: [],
      status: 'pending',
    });

    await quizGenerationQueue.add('generate', {
      triggerId: trigger._id.toString(),
      userId: userId.toString(),
      topic: competencyName,
      contentIds: [],
      type: 'on_demand',
      questionCount,
      assessmentType: assessmentType || 'mixed',
      objectiveId: objectiveId?.toString(),
      isSkillAssessment: true,
    }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 10000 },
      priority: 5,
    });

    trigger.status = 'queued';
    await trigger.save();
    return trigger;
  }

  /**
   * Retention check quiz (called from cronJobs).
   */
  async triggerRetentionCheck(userId, topic, contentIds) {
    const trigger = await QuizTrigger.create({
      userId,
      triggerType: 'retention_check',
      topic,
      sourceContentIds: contentIds,
      status: 'pending',
    });

    await quizGenerationQueue.add('generate', {
      triggerId: trigger._id.toString(),
      userId: userId.toString(),
      topic,
      contentIds: contentIds.map(id => id.toString()),
      type: 'retention_check',
    });

    trigger.status = 'queued';
    await trigger.save();
    return trigger;
  }
}

module.exports = new QuizTriggerService();
