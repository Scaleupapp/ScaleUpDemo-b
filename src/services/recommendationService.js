const Content = require('../models/Content');
const ContentProgress = require('../models/ContentProgress');
const ContentInteraction = require('../models/ContentInteraction');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const UserObjective = require('../models/UserObjective');
const Quiz = require('../models/Quiz');
const Journey = require('../models/Journey');
const { DIFFICULTY_MIX } = require('../utils/constants');
const { paginationMeta } = require('../utils/pagination');

// ─── Scoring weight constants ──────────────────────────────────────────────────
const SCORE_WEIGHTS = {
  TOPIC_RELEVANCE_MAX: 40,
  DIFFICULTY_MATCH_MAX: 20,
  QUALITY_MAX: 15,
  SOCIAL_PROOF_MAX: 10,
  RECENCY_MAX: 5,
  DIVERSITY_PENALTY_MAX: -5,
  GAP_BONUS_MAX: 10,
};

// ─── Objective weighting ───────────────────────────────────────────────────────
const PRIMARY_OBJECTIVE_WEIGHT = 0.70;
const SECONDARY_OBJECTIVES_POOL = 0.30;

// ─── Recency thresholds (in milliseconds) ──────────────────────────────────────
const MS_PER_DAY = 86400000;
const RECENCY_7_DAYS = 7 * MS_PER_DAY;
const RECENCY_30_DAYS = 30 * MS_PER_DAY;

// ─── Social proof normalization caps ────────────────────────────────────────────
const SOCIAL_CAPS = {
  likes: 500,
  saves: 200,
  rating: 5,
  ratingCount: 100,
};

// ─── Source fairness target ratio ───────────────────────────────────────────────
const SOURCE_FAIRNESS_TARGET = { original: 0.5, youtube: 0.5 };

class RecommendationService {

  // ═══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC METHODS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Main personalized feed — uses objectives, knowledge profile, and consumption
   * history to score and rank all published content for a user.
   */
  async getPersonalizedFeed(userId, { page = 1, limit = 20 } = {}) {
    const [objectives, knowledgeProfile, consumptionGraph, consumedIds] = await Promise.all([
      UserObjective.find({ userId, status: 'active' }),
      KnowledgeProfile.findOne({ userId }),
      ConsumptionGraph.findOne({ userId }),
      this._getConsumedContentIds(userId),
    ]);

    // Cold start redirect — if the user has no objectives and no consumption, fall back
    if (!objectives.length && (!consumptionGraph || consumptionGraph.totalContentConsumed === 0)) {
      return this.getColdStartFeed(userId, { page, limit });
    }

    // Gather all objective topics (weighted)
    const objectiveTopics = this._buildObjectiveTopicWeights(objectives);

    // Fetch candidate content — published, not yet consumed
    const candidates = await Content.find({
      status: 'published',
      _id: { $nin: consumedIds },
    }).lean();

    // Score each candidate
    const scored = candidates.map(content => ({
      content,
      score: this._scoreContent(content, {
        objectives,
        objectiveTopics,
        knowledgeProfile,
        consumptionGraph,
        consumedIds,
      }),
    }));

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    // Apply source fairness interleaving
    const reranked = this._applySourceFairness(scored);

    // Paginate
    const total = reranked.length;
    const start = (page - 1) * limit;
    const items = reranked.slice(start, start + limit).map(s => ({
      ...s.content,
      _recommendationScore: Math.round(s.score * 100) / 100,
    }));

    return {
      items,
      pagination: paginationMeta(total, page, limit),
    };
  }

  /**
   * Cold start feed — for users who just finished onboarding but have no
   * consumption history. Uses onboarding data (objectives, currentLevel,
   * topicsOfInterest, preferredLearningStyle) to bootstrap recommendations.
   */
  async getColdStartFeed(userId, { page = 1, limit = 20 } = {}) {
    const objectives = await UserObjective.find({ userId, status: 'active' });

    // Collect topics of interest and current level from objectives
    let topicsOfInterest = [];
    let currentLevel = 'beginner';
    let preferredLearningStyle = 'mix';

    if (objectives.length) {
      const primary = objectives.find(o => o.isPrimary) || objectives[0];
      topicsOfInterest = [...new Set(objectives.flatMap(o => o.topicsOfInterest || []))];
      currentLevel = primary.currentLevel || 'beginner';
      preferredLearningStyle = primary.preferredLearningStyle || 'mix';
    }

    const difficultyMix = DIFFICULTY_MIX[currentLevel] || DIFFICULTY_MIX.beginner;

    // Build content type filter based on learning style
    const contentTypeFilter = this._learningStyleToContentTypes(preferredLearningStyle);

    // Query: published content matching the user's interest topics
    const query = { status: 'published' };
    if (topicsOfInterest.length) {
      query.topics = { $in: topicsOfInterest };
    }
    if (contentTypeFilter) {
      query.contentType = { $in: contentTypeFilter };
    }

    const candidates = await Content.find(query)
      .sort({ 'aiData.qualityScore': -1, publishedAt: -1 })
      .lean();

    // Score with difficulty mix preference
    const scored = candidates.map(content => {
      let score = 0;

      // Topic match (simple for cold start — binary match)
      const overlap = content.topics.filter(t => topicsOfInterest.includes(t)).length;
      const topicScore = topicsOfInterest.length > 0
        ? (overlap / topicsOfInterest.length) * SCORE_WEIGHTS.TOPIC_RELEVANCE_MAX
        : SCORE_WEIGHTS.TOPIC_RELEVANCE_MAX * 0.5; // neutral if no interests specified
      score += topicScore;

      // Difficulty calibration
      score += this._difficultyMatchScore(content.difficulty, currentLevel, difficultyMix);

      // Quality
      score += this._qualityScore(content);

      // Social proof
      score += this._socialProofScore(content);

      // Recency
      score += this._recencyScore(content);

      return { content, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const reranked = this._applySourceFairness(scored);

    const total = reranked.length;
    const start = (page - 1) * limit;
    const items = reranked.slice(start, start + limit).map(s => ({
      ...s.content,
      _recommendationScore: Math.round(s.score * 100) / 100,
    }));

    return {
      items,
      pagination: paginationMeta(total, page, limit),
    };
  }

  /**
   * "Because you watched X" — finds content similar to a given piece of content
   * using topic/tag overlap, same domain, and similar difficulty.
   */
  async getSimilarContent(contentId, { limit = 10 } = {}) {
    const source = await Content.findById(contentId).lean();
    if (!source) return { items: [] };

    const candidates = await Content.find({
      _id: { $ne: contentId },
      status: 'published',
      $or: [
        { topics: { $in: source.topics || [] } },
        { tags: { $in: source.tags || [] } },
        { domain: source.domain },
      ],
    }).lean();

    const scored = candidates.map(content => {
      let score = 0;

      // Topic overlap
      const topicOverlap = content.topics.filter(t => (source.topics || []).includes(t)).length;
      const maxTopics = Math.max(1, source.topics?.length || 1);
      score += (topicOverlap / maxTopics) * 30;

      // Tag overlap
      const tagOverlap = content.tags.filter(t => (source.tags || []).includes(t)).length;
      const maxTags = Math.max(1, source.tags?.length || 1);
      score += (tagOverlap / maxTags) * 15;

      // Same domain bonus
      if (content.domain === source.domain) score += 10;

      // Difficulty proximity bonus (same = 10, one step = 5, two steps = 0)
      const difficultyLevels = ['beginner', 'intermediate', 'advanced'];
      const srcIdx = difficultyLevels.indexOf(source.difficulty);
      const candIdx = difficultyLevels.indexOf(content.difficulty);
      const diffDist = Math.abs(srcIdx - candIdx);
      score += diffDist === 0 ? 10 : diffDist === 1 ? 5 : 0;

      // Quality
      score += this._qualityScore(content);

      // Social proof
      score += this._socialProofScore(content);

      // Recency
      score += this._recencyScore(content);

      return { content, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const items = scored.slice(0, limit).map(s => ({
      ...s.content,
      _similarityScore: Math.round(s.score * 100) / 100,
    }));

    return { items };
  }

  /**
   * "Recommended for your objective" — content specifically targeted at a
   * particular active objective's topics and difficulty level.
   */
  async getObjectiveRecommendations(userId, objectiveId, { limit = 10 } = {}) {
    const [objective, consumedIds] = await Promise.all([
      UserObjective.findOne({ _id: objectiveId, userId, status: 'active' }),
      this._getConsumedContentIds(userId),
    ]);

    if (!objective) return { items: [] };

    const knowledgeProfile = await KnowledgeProfile.findOne({ userId });

    const topics = objective.topicsOfInterest || [];
    const currentLevel = objective.currentLevel || 'beginner';
    const difficultyMix = DIFFICULTY_MIX[currentLevel] || DIFFICULTY_MIX.beginner;

    // Query 1: Fresh content (excludes consumed/completed content)
    const freshQuery = {
      status: 'published',
      _id: { $nin: consumedIds },
    };
    if (topics.length) {
      freshQuery.topics = { $in: topics };
    }

    // Query 2: Completed content relevant to this objective (capped at 10)
    const completedQuery = {
      status: 'published',
      _id: { $in: consumedIds },
    };
    if (topics.length) {
      completedQuery.topics = { $in: topics };
    }

    const [freshCandidates, completedCandidates] = await Promise.all([
      Content.find(freshQuery).lean(),
      consumedIds.length > 0 ? Content.find(completedQuery).limit(10).lean() : Promise.resolve([]),
    ]);

    // Scoring helper for this objective
    const scoreForObjective = (content) => {
      let score = 0;

      // Topic relevance to this objective
      const overlap = content.topics.filter(t => topics.includes(t)).length;
      score += topics.length > 0
        ? (overlap / topics.length) * SCORE_WEIGHTS.TOPIC_RELEVANCE_MAX
        : 0;

      // Difficulty calibration
      score += this._difficultyMatchScore(content.difficulty, currentLevel, difficultyMix);

      // Quality
      score += this._qualityScore(content);

      // Social proof
      score += this._socialProofScore(content);

      // Recency
      score += this._recencyScore(content);

      // Gap bonus — if knowledge profile says this topic is weak
      if (knowledgeProfile) {
        score += this._gapBonusScore(content, knowledgeProfile);
      }

      return score;
    };

    // Score fresh content
    const freshScored = freshCandidates.map(content => ({
      content,
      score: scoreForObjective(content),
      isCompleted: false,
    }));
    freshScored.sort((a, b) => b.score - a.score);

    // Score completed content
    const completedScored = completedCandidates.map(content => ({
      content,
      score: scoreForObjective(content),
      isCompleted: true,
    }));
    completedScored.sort((a, b) => b.score - a.score);

    // Merge: fresh first (sorted by score), then completed (sorted by score)
    const combined = [...freshScored, ...completedScored].slice(0, limit);

    const items = combined.map(s => ({
      ...s.content,
      _recommendationScore: Math.round(s.score * 100) / 100,
      _forObjective: objective.objectiveType,
      isCompleted: s.isCompleted,
    }));

    return { items };
  }

  /**
   * Gap-filling recommendations — content that covers the user's weakest topics
   * as identified by the knowledge profile.
   */
  async getGapFillingRecommendations(userId, { limit = 10 } = {}) {
    const [knowledgeProfile, consumedIds] = await Promise.all([
      KnowledgeProfile.findOne({ userId }),
      this._getConsumedContentIds(userId),
    ]);

    if (!knowledgeProfile || !knowledgeProfile.weaknesses?.length) {
      return { items: [] };
    }

    const weakTopics = knowledgeProfile.weaknesses;

    // Find the mastery entries for weak topics to understand their levels
    const weakMasteryMap = {};
    for (const topic of weakTopics) {
      const entry = knowledgeProfile.topicMastery.find(t => t.topic === topic);
      weakMasteryMap[topic] = entry ? entry.level : 'beginner';
    }

    const candidates = await Content.find({
      status: 'published',
      topics: { $in: weakTopics },
      _id: { $nin: consumedIds },
    }).lean();

    const scored = candidates.map(content => {
      let score = 0;

      // How many weak topics does this content cover?
      const weakOverlap = content.topics.filter(t => weakTopics.includes(t));
      score += (weakOverlap.length / weakTopics.length) * SCORE_WEIGHTS.TOPIC_RELEVANCE_MAX;

      // Difficulty match — prefer easier content for weaker topics
      // Use the weakest matching topic's level for calibration
      const weakestLevel = weakOverlap.reduce((weakest, topic) => {
        const level = weakMasteryMap[topic] || 'beginner';
        const order = ['not_started', 'beginner', 'intermediate', 'advanced', 'expert'];
        return order.indexOf(level) < order.indexOf(weakest) ? level : weakest;
      }, 'advanced');
      const calibrationLevel = weakestLevel === 'not_started' ? 'beginner' : weakestLevel;
      const difficultyMix = DIFFICULTY_MIX[calibrationLevel] || DIFFICULTY_MIX.beginner;
      score += this._difficultyMatchScore(content.difficulty, calibrationLevel, difficultyMix);

      // Quality
      score += this._qualityScore(content);

      // Social proof
      score += this._socialProofScore(content);

      // Recency
      score += this._recencyScore(content);

      // Extra gap bonus — proportional to how weak the user is in this topic
      for (const topic of weakOverlap) {
        const entry = knowledgeProfile.topicMastery.find(t => t.topic === topic);
        if (entry) {
          // Lower score = bigger gap = higher bonus
          const gapIntensity = (100 - entry.score) / 100;
          score += gapIntensity * (SCORE_WEIGHTS.GAP_BONUS_MAX / weakOverlap.length);
        }
      }

      return { content, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const items = scored.slice(0, limit).map(s => ({
      ...s.content,
      _recommendationScore: Math.round(s.score * 100) / 100,
      _reason: 'gap_filling',
    }));

    return { items };
  }

  /**
   * Trending content in topics the user follows or has affinity for.
   * Looks at recent high-engagement content in the user's topic areas.
   */
  async getTrendingInTopics(userId, { limit = 10 } = {}) {
    const [consumptionGraph, objectives, consumedIds] = await Promise.all([
      ConsumptionGraph.findOne({ userId }),
      UserObjective.find({ userId, status: 'active' }),
      this._getConsumedContentIds(userId),
    ]);

    // Gather the user's topics from consumption + objectives
    const userTopics = new Set();
    if (consumptionGraph) {
      for (const node of consumptionGraph.topicNodes) {
        userTopics.add(node.topic);
      }
    }
    for (const obj of objectives) {
      for (const topic of (obj.topicsOfInterest || [])) {
        userTopics.add(topic);
      }
    }

    if (userTopics.size === 0) {
      // No topics to trend on — return globally trending content
      return this._getGlobalTrending(consumedIds, limit);
    }

    const topicsArray = [...userTopics];

    // Trending = published in last 14 days with high engagement
    const twoWeeksAgo = new Date(Date.now() - 14 * MS_PER_DAY);

    const candidates = await Content.find({
      status: 'published',
      topics: { $in: topicsArray },
      publishedAt: { $gte: twoWeeksAgo },
      _id: { $nin: consumedIds },
    })
      .sort({ viewCount: -1, likeCount: -1, publishedAt: -1 })
      .lean();

    // Score by engagement + topic match
    const scored = candidates.map(content => {
      let score = 0;

      // Topic overlap with user's topics
      const overlap = content.topics.filter(t => userTopics.has(t)).length;
      score += (overlap / Math.max(1, content.topics.length)) * 30;

      // Engagement score (normalized)
      score += this._socialProofScore(content) * 2; // Double weight for trending

      // Recency
      score += this._recencyScore(content);

      // Quality
      score += this._qualityScore(content);

      return { content, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const items = scored.slice(0, limit).map(s => ({
      ...s.content,
      _trendingScore: Math.round(s.score * 100) / 100,
    }));

    return { items };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //  CORE SCORING FUNCTION
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Scores a single piece of content for a user based on multiple factors:
   *  1. Topic relevance       (0 – 40 pts)
   *  2. Difficulty match      (0 – 20 pts)
   *  3. Quality score         (0 – 15 pts)
   *  4. Social proof          (0 – 10 pts)
   *  5. Recency               (0 –  5 pts)
   *  6. Diversity penalty     (-5 –  0 pts)
   *  7. Gap bonus             (0 – 10 pts)
   *
   * Theoretical max: 100 pts
   *
   * @param {Object} content - Content document (lean object)
   * @param {Object} ctx - Context: objectives, objectiveTopics, knowledgeProfile, consumptionGraph, consumedIds
   * @returns {number} Final score
   */
  _scoreContent(content, { objectives = [], objectiveTopics = null, knowledgeProfile, consumptionGraph, consumedIds = [] } = {}) {
    let totalScore = 0;

    // ── 1. Topic Relevance (0–40) ───────────────────────────────────────────
    const topicWeights = objectiveTopics || this._buildObjectiveTopicWeights(objectives);
    totalScore += this._topicRelevanceScore(content, topicWeights, consumptionGraph);

    // ── 2. Difficulty Match (0–20) ──────────────────────────────────────────
    const userLevel = this._inferUserLevel(objectives, knowledgeProfile, content.topics);
    const difficultyMix = DIFFICULTY_MIX[userLevel] || DIFFICULTY_MIX.beginner;
    totalScore += this._difficultyMatchScore(content.difficulty, userLevel, difficultyMix);

    // ── 3. Quality Score (0–15) ─────────────────────────────────────────────
    totalScore += this._qualityScore(content);

    // ── 4. Social Proof (0–10) ──────────────────────────────────────────────
    totalScore += this._socialProofScore(content);

    // ── 5. Recency (0–5) ────────────────────────────────────────────────────
    totalScore += this._recencyScore(content);

    // ── 6. Diversity Penalty (-5–0) ─────────────────────────────────────────
    totalScore += this._diversityPenalty(content, consumptionGraph);

    // ── 7. Gap Bonus (0–10) ─────────────────────────────────────────────────
    if (knowledgeProfile) {
      totalScore += this._gapBonusScore(content, knowledgeProfile);
    }

    return totalScore;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //  SCORING SUB-FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Topic Relevance (0–40 pts)
   * Combines objective-topic weights with consumption-graph affinity.
   */
  _topicRelevanceScore(content, topicWeights, consumptionGraph) {
    const contentTopics = content.topics || [];
    if (!contentTopics.length) return 0;

    let objectiveScore = 0;
    let affinityScore = 0;

    // Objective-based relevance (0–30 pts of the 40)
    if (Object.keys(topicWeights).length > 0) {
      let matchWeight = 0;
      for (const topic of contentTopics) {
        if (topicWeights[topic]) {
          matchWeight += topicWeights[topic];
        }
      }
      // Normalize: the highest possible matchWeight would be 1.0 (if all content
      // topics perfectly match with full weight), so cap at 1.0
      objectiveScore = Math.min(1, matchWeight) * 30;
    }

    // Consumption affinity (0–10 pts of the 40)
    if (consumptionGraph && consumptionGraph.topicNodes?.length) {
      const maxAffinity = Math.max(...consumptionGraph.topicNodes.map(n => n.affinityScore || 0), 1);
      let affinitySum = 0;
      for (const topic of contentTopics) {
        const node = consumptionGraph.topicNodes.find(n => n.topic === topic);
        if (node && node.affinityScore > 0) {
          affinitySum += node.affinityScore / maxAffinity;
        }
      }
      affinityScore = Math.min(1, affinitySum / contentTopics.length) * 10;
    }

    return objectiveScore + affinityScore;
  }

  /**
   * Difficulty Match (0–20 pts)
   * Uses the DIFFICULTY_MIX distribution to score how well this content's
   * difficulty fits the user's current level.
   */
  _difficultyMatchScore(contentDifficulty, userLevel, difficultyMix) {
    if (!difficultyMix) return 0;

    // Map content difficulty to the mix key
    const difficultyKey = this._difficultyToMixKey(contentDifficulty);
    if (!difficultyKey) return 0;

    // The mix percentage (e.g., 50 for beginner/easy) represents how desirable
    // this difficulty is. Normalize to 0–20 range.
    const desirability = difficultyMix[difficultyKey] || 0;
    return (desirability / 50) * SCORE_WEIGHTS.DIFFICULTY_MATCH_MAX;
  }

  /**
   * Quality Score (0–15 pts)
   * Based on aiData.qualityScore (0–100) normalized to 0–15.
   */
  _qualityScore(content) {
    const raw = content.aiData?.qualityScore;
    if (raw == null) return SCORE_WEIGHTS.QUALITY_MAX * 0.5; // Neutral if not yet scored
    return (raw / 100) * SCORE_WEIGHTS.QUALITY_MAX;
  }

  /**
   * Social Proof (0–10 pts)
   * Combines likes, saves, and average rating.
   */
  _socialProofScore(content) {
    const likePart = Math.min(1, (content.likeCount || 0) / SOCIAL_CAPS.likes) * 3;
    const savePart = Math.min(1, (content.saveCount || 0) / SOCIAL_CAPS.saves) * 3;
    const ratingPart = content.ratingCount > 0
      ? (Math.min(SOCIAL_CAPS.rating, content.averageRating || 0) / SOCIAL_CAPS.rating) *
        Math.min(1, content.ratingCount / SOCIAL_CAPS.ratingCount) * 4
      : 0;

    return Math.min(SCORE_WEIGHTS.SOCIAL_PROOF_MAX, likePart + savePart + ratingPart);
  }

  /**
   * Recency (0–5 pts)
   * Published in last 7 days = 5, last 30 days = 3, older = 1.
   */
  _recencyScore(content) {
    if (!content.publishedAt) return 0;
    const age = Date.now() - new Date(content.publishedAt).getTime();
    if (age <= RECENCY_7_DAYS) return 5;
    if (age <= RECENCY_30_DAYS) return 3;
    return 1;
  }

  /**
   * Diversity Penalty (-5–0 pts)
   * If the user has already consumed a lot of content in this topic,
   * penalize to promote topic diversity.
   */
  _diversityPenalty(content, consumptionGraph) {
    if (!consumptionGraph || !consumptionGraph.topicNodes?.length) return 0;

    const totalConsumed = consumptionGraph.totalContentConsumed || 1;
    const contentTopics = content.topics || [];

    let maxTopicConcentration = 0;
    for (const topic of contentTopics) {
      const node = consumptionGraph.topicNodes.find(n => n.topic === topic);
      if (node) {
        const concentration = node.contentConsumed / totalConsumed;
        maxTopicConcentration = Math.max(maxTopicConcentration, concentration);
      }
    }

    // If over 40% of consumed content is in this topic, apply increasing penalty
    if (maxTopicConcentration > 0.4) {
      // Scale from 0 to -5 as concentration goes from 0.4 to 1.0
      const penaltyRatio = Math.min(1, (maxTopicConcentration - 0.4) / 0.6);
      return SCORE_WEIGHTS.DIVERSITY_PENALTY_MAX * penaltyRatio;
    }

    return 0;
  }

  /**
   * Gap Bonus (0–10 pts)
   * Bonus for content that covers topics the user is weak in.
   */
  _gapBonusScore(content, knowledgeProfile) {
    if (!knowledgeProfile || !knowledgeProfile.weaknesses?.length) return 0;

    const contentTopics = content.topics || [];
    const weaknessSet = new Set(knowledgeProfile.weaknesses);

    let gapTopicsInContent = 0;
    let totalGapIntensity = 0;

    for (const topic of contentTopics) {
      if (weaknessSet.has(topic)) {
        gapTopicsInContent++;
        const entry = knowledgeProfile.topicMastery.find(t => t.topic === topic);
        if (entry) {
          // Lower mastery score = larger gap = more bonus
          totalGapIntensity += (100 - entry.score) / 100;
        } else {
          totalGapIntensity += 1; // Full intensity if no mastery entry at all
        }
      }
    }

    if (gapTopicsInContent === 0) return 0;

    // Normalize: average intensity * max bonus, capped
    const avgIntensity = totalGapIntensity / gapTopicsInContent;
    const coverageBonus = Math.min(1, gapTopicsInContent / 3); // Covering multiple gaps is better
    return avgIntensity * coverageBonus * SCORE_WEIGHTS.GAP_BONUS_MAX;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //  INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Get IDs of all content the user has started or completed.
   */
  async _getConsumedContentIds(userId) {
    const progressDocs = await ContentProgress.find(
      { userId },
      { contentId: 1 }
    ).lean();
    return progressDocs.map(p => p.contentId);
  }

  /**
   * Build a weighted topic map from user objectives.
   * Primary objective gets 70% weight; secondaries split the remaining 30%.
   *
   * Returns: { "javascript": 0.35, "react": 0.35, "system-design": 0.15, ... }
   */
  _buildObjectiveTopicWeights(objectives) {
    if (!objectives || !objectives.length) return {};

    const primary = objectives.find(o => o.isPrimary);
    const secondaries = objectives.filter(o => !o.isPrimary);

    const weights = {};

    // Helper to distribute a total weight evenly across an objective's topics
    const distribute = (topics, totalWeight) => {
      if (!topics || !topics.length) return;
      const perTopic = totalWeight / topics.length;
      for (const topic of topics) {
        weights[topic] = (weights[topic] || 0) + perTopic;
      }
    };

    if (primary) {
      distribute(primary.topicsOfInterest, PRIMARY_OBJECTIVE_WEIGHT);
    }

    if (secondaries.length) {
      const perSecondary = SECONDARY_OBJECTIVES_POOL / secondaries.length;
      for (const sec of secondaries) {
        distribute(sec.topicsOfInterest, perSecondary);
      }
    }

    // If no primary was designated, treat all objectives equally
    if (!primary && objectives.length) {
      const perObj = 1.0 / objectives.length;
      for (const obj of objectives) {
        distribute(obj.topicsOfInterest, perObj);
      }
    }

    return weights;
  }

  /**
   * Infer the user's effective mastery level for a set of content topics.
   * Looks at knowledge profile mastery for matching topics, falls back to
   * objective-declared currentLevel, then defaults to 'beginner'.
   */
  _inferUserLevel(objectives, knowledgeProfile, contentTopics) {
    // Try to find mastery level from knowledge profile for these specific topics
    if (knowledgeProfile && knowledgeProfile.topicMastery?.length && contentTopics?.length) {
      const matchingEntries = knowledgeProfile.topicMastery.filter(
        t => contentTopics.includes(t.topic) && t.level !== 'not_started'
      );
      if (matchingEntries.length) {
        const avgScore = matchingEntries.reduce((sum, t) => sum + t.score, 0) / matchingEntries.length;
        if (avgScore >= 70) return 'advanced';
        if (avgScore >= 40) return 'intermediate';
        return 'beginner';
      }
    }

    // Fall back to the primary objective's declared current level
    if (objectives?.length) {
      const primary = objectives.find(o => o.isPrimary) || objectives[0];
      return primary.currentLevel || 'beginner';
    }

    return 'beginner';
  }

  /**
   * Map content difficulty enum to DIFFICULTY_MIX keys.
   * Content difficulty uses 'beginner'/'intermediate'/'advanced'
   * but the mix keys are 'easy'/'medium'/'hard'.
   */
  _difficultyToMixKey(difficulty) {
    const map = {
      beginner: 'easy',
      intermediate: 'medium',
      advanced: 'hard',
    };
    return map[difficulty] || 'medium';
  }

  /**
   * Convert preferredLearningStyle to content type filters.
   */
  _learningStyleToContentTypes(style) {
    switch (style) {
      case 'videos': return ['video'];
      case 'articles': return ['article'];
      case 'interactive': return ['video', 'infographic'];
      case 'mix': return null; // No filter — allow all types
      default: return null;
    }
  }

  /**
   * Source fairness interleaving.
   * Ensures a roughly balanced mix of original and youtube content
   * so neither source type dominates the feed.
   *
   * Uses a round-robin approach: for each position, pick from the source
   * that is most behind the target ratio.
   */
  _applySourceFairness(scored) {
    if (!scored.length) return scored;

    const original = scored.filter(s => s.content.sourceType !== 'youtube');
    const youtube = scored.filter(s => s.content.sourceType === 'youtube');

    // If only one source type exists, just return as-is
    if (!original.length || !youtube.length) return scored;

    const result = [];
    let origIdx = 0;
    let ytIdx = 0;

    while (origIdx < original.length || ytIdx < youtube.length) {
      const totalSoFar = result.length || 1;
      const origRatio = result.filter(s => s.content.sourceType !== 'youtube').length / totalSoFar;
      const ytRatio = result.filter(s => s.content.sourceType === 'youtube').length / totalSoFar;

      // Pick from whichever source is further behind its target ratio
      if (origIdx < original.length && (origRatio <= SOURCE_FAIRNESS_TARGET.original || ytIdx >= youtube.length)) {
        result.push(original[origIdx++]);
      } else if (ytIdx < youtube.length) {
        result.push(youtube[ytIdx++]);
      } else if (origIdx < original.length) {
        result.push(original[origIdx++]);
      }
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //  INTELLIGENT NEXT ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * "What to do next" — aggregates the user's state across journey, quizzes,
   * and knowledge to produce a prioritized list of next actions.
   *
   * Priority order:
   * 1. Pending quiz (user needs to take it)
   * 2. In-progress content (resume what you started)
   * 3. Today's journey assignment (assigned content for today)
   * 4. Knowledge gap content (fill weak areas)
   * 5. Personalized recommendation (explore new content)
   */
  async getNextActions(userId) {
    const [pendingQuizzes, inProgressContent, journey, knowledgeProfile, consumedIds] = await Promise.all([
      Quiz.find({ userId, status: { $in: ['ready', 'delivered'] } }).sort({ createdAt: -1 }).limit(3).lean(),
      ContentProgress.find({ userId, status: 'in_progress' }).sort({ lastAccessedAt: -1 }).limit(3).lean(),
      Journey.findOne({ userId, status: 'active' }),
      KnowledgeProfile.findOne({ userId }),
      this._getConsumedContentIds(userId),
    ]);

    const actions = [];

    // 1. Pending quizzes — highest priority
    for (const quiz of pendingQuizzes) {
      actions.push({
        priority: 1,
        type: 'take_quiz',
        label: `Quiz ready: ${quiz.topic}`,
        subtitle: `${quiz.totalQuestions} questions on ${quiz.topic}`,
        quizId: quiz._id,
        topic: quiz.topic,
      });
    }

    // 2. In-progress content — resume
    if (inProgressContent.length > 0) {
      const contentIds = inProgressContent.map(p => p.contentId);
      const contents = await Content.find({ _id: { $in: contentIds } }).lean();
      const contentMap = {};
      for (const c of contents) contentMap[c._id.toString()] = c;

      for (const progress of inProgressContent) {
        const content = contentMap[progress.contentId.toString()];
        if (content) {
          actions.push({
            priority: 2,
            type: 'resume_content',
            label: `Continue: ${content.title}`,
            subtitle: `${Math.round(progress.progressPercentage || 0)}% complete`,
            contentId: content._id,
            content: {
              _id: content._id,
              title: content.title,
              contentType: content.contentType,
              domain: content.domain,
              topics: content.topics,
              duration: content.duration,
              thumbnailUrl: content.thumbnailUrl,
              creator: content.creator,
              sourceType: content.sourceType,
            },
            progressPercentage: progress.progressPercentage || 0,
          });
        }
      }
    }

    // 3. Today's journey assignment
    if (journey) {
      const currentWeekPlan = journey.weeklyPlans.find(w => w.weekNumber === journey.currentWeek);
      const dayOfWeek = new Date().getDay() || 7;
      const todayAssignment = currentWeekPlan?.dailyAssignments.find(d => d.day === dayOfWeek);

      if (todayAssignment && !todayAssignment.completed) {
        const todayContentIds = todayAssignment.contentIds || [];
        const todayContent = await Content.find({ _id: { $in: todayContentIds } }).lean();
        const todayProgress = await ContentProgress.find({
          userId, contentId: { $in: todayContentIds },
        }).lean();
        const progressSet = new Set(todayProgress.filter(p => p.status === 'completed').map(p => p.contentId.toString()));

        const unfinished = todayContent.filter(c => !progressSet.has(c._id.toString()));
        if (unfinished.length > 0) {
          actions.push({
            priority: 3,
            type: 'journey_today',
            label: `Today's plan: ${unfinished.length} item${unfinished.length > 1 ? 's' : ''} left`,
            subtitle: todayAssignment.topics?.join(', ') || 'Daily learning',
            items: unfinished.slice(0, 3).map(c => ({
              _id: c._id,
              title: c.title,
              contentType: c.contentType,
              duration: c.duration,
              thumbnailUrl: c.thumbnailUrl,
              creator: c.creator,
              sourceType: c.sourceType,
            })),
          });
        }
      }
    }

    // 4. Knowledge gap recommendation
    if (knowledgeProfile && knowledgeProfile.weaknesses?.length > 0) {
      try {
        const gapRecs = await this.getGapFillingRecommendations(userId, { limit: 2 });
        if (gapRecs.items?.length > 0) {
          const weakTopics = knowledgeProfile.weaknesses.slice(0, 3).join(', ');
          actions.push({
            priority: 4,
            type: 'fill_gaps',
            label: `Strengthen: ${weakTopics}`,
            subtitle: 'Content to improve your weakest areas',
            items: gapRecs.items.slice(0, 2).map(c => ({
              _id: c._id,
              title: c.title,
              contentType: c.contentType,
              duration: c.duration,
              thumbnailUrl: c.thumbnailUrl,
              creator: c.creator,
              sourceType: c.sourceType,
              topics: c.topics,
            })),
          });
        }
      } catch (_) { /* Non-critical */ }
    }

    // 5. Personalized exploration
    try {
      const feed = await this.getPersonalizedFeed(userId, { page: 1, limit: 3 });
      if (feed.items?.length > 0) {
        actions.push({
          priority: 5,
          type: 'explore',
          label: 'Explore new content',
          subtitle: 'Picked for you based on your interests',
          items: feed.items.slice(0, 3).map(c => ({
            _id: c._id,
            title: c.title,
            contentType: c.contentType,
            duration: c.duration,
            thumbnailUrl: c.thumbnailUrl,
            creator: c.creator,
            sourceType: c.sourceType,
            topics: c.topics,
          })),
        });
      }
    } catch (_) { /* Non-critical */ }

    // Sort by priority
    actions.sort((a, b) => a.priority - b.priority);

    return { actions };
  }

  /**
   * Post-quiz recommendations — specifically finds content to strengthen
   * weak topics identified from a quiz attempt.
   */
  async getPostQuizRecommendations(userId, weakTopics) {
    if (!weakTopics || weakTopics.length === 0) {
      // Fall back to general gap-filling
      return this.getGapFillingRecommendations(userId, { limit: 5 });
    }

    const consumedIds = await this._getConsumedContentIds(userId);
    const knowledgeProfile = await KnowledgeProfile.findOne({ userId });

    const candidates = await Content.find({
      status: 'published',
      topics: { $in: weakTopics },
      _id: { $nin: consumedIds },
    }).lean();

    const scored = candidates.map(content => {
      let score = 0;

      // How many weak topics does this content address?
      const weakOverlap = content.topics.filter(t => weakTopics.includes(t));
      score += (weakOverlap.length / Math.max(1, weakTopics.length)) * 40;

      // Prefer easier content for remediation
      if (content.difficulty === 'beginner') score += 15;
      else if (content.difficulty === 'intermediate') score += 10;
      else score += 5;

      // Quality
      score += this._qualityScore(content);

      // Social proof
      score += this._socialProofScore(content);

      // Knowledge gap intensity bonus
      if (knowledgeProfile) {
        for (const topic of weakOverlap) {
          const entry = knowledgeProfile.topicMastery.find(t => t.topic === topic);
          if (entry) {
            const gapIntensity = (100 - entry.score) / 100;
            score += gapIntensity * 10;
          }
        }
      }

      return { content, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const items = scored.slice(0, 5).map(s => ({
      ...s.content,
      _recommendationScore: Math.round(s.score * 100) / 100,
      _reason: `Strengthen ${s.content.topics.filter(t => weakTopics.includes(t)).join(', ')}`,
    }));

    return { items };
  }

  /**
   * Global trending — fallback when user has no topic preferences.
   */
  async _getGlobalTrending(consumedIds, limit) {
    const twoWeeksAgo = new Date(Date.now() - 14 * MS_PER_DAY);

    const items = await Content.find({
      status: 'published',
      publishedAt: { $gte: twoWeeksAgo },
      _id: { $nin: consumedIds },
    })
      .sort({ viewCount: -1, likeCount: -1, publishedAt: -1 })
      .limit(limit)
      .lean();

    return {
      items: items.map(c => ({ ...c, _trendingScore: null })),
    };
  }
}

module.exports = new RecommendationService();
