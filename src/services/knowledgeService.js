const KnowledgeProfile = require('../models/KnowledgeProfile');
const QuizAttempt = require('../models/QuizAttempt');
const Quiz = require('../models/Quiz');
const { journeyAdaptationQueue } = require('../config/queue');

class KnowledgeService {

  /**
   * Called after a quiz is scored (via quizAnalyzer worker).
   * Updates the user's KnowledgeProfile based on quiz results.
   */
  async updateFromQuizAttempt(attemptId, userId) {
    const attempt = await QuizAttempt.findById(attemptId);
    if (!attempt || attempt.status !== 'completed') return;

    const quiz = await Quiz.findById(attempt.quizId);
    if (!quiz) return;

    let profile = await KnowledgeProfile.findOne({ userId });
    if (!profile) {
      profile = await KnowledgeProfile.create({ userId, topicMastery: [] });
    }

    // Update per-topic mastery from the attempt's topic breakdown
    for (const breakdown of (attempt.topicBreakdown || [])) {
      const newScore = breakdown.percentage;
      let topicEntry = profile.topicMastery.find(t => t.topic === breakdown.topic);

      if (topicEntry) {
        // Weighted average: 60% new score, 40% old score
        const oldScore = topicEntry.score;
        topicEntry.score = Math.round(newScore * 0.6 + oldScore * 0.4);
        topicEntry.level = this._scoreToLevel(topicEntry.score);
        topicEntry.quizzesTaken += 1;
        topicEntry.lastAssessedAt = new Date();
        topicEntry.scoreHistory.push({
          score: newScore,
          date: new Date(),
          quizId: quiz._id,
        });
        // Keep last 20 history entries
        if (topicEntry.scoreHistory.length > 20) {
          topicEntry.scoreHistory = topicEntry.scoreHistory.slice(-20);
        }
        topicEntry.trend = this._calculateTrend(topicEntry.scoreHistory);
      } else {
        profile.topicMastery.push({
          topic: breakdown.topic,
          score: newScore,
          level: this._scoreToLevel(newScore),
          quizzesTaken: 1,
          lastAssessedAt: new Date(),
          scoreHistory: [{ score: newScore, date: new Date(), quizId: quiz._id }],
          trend: 'stable',
        });
      }
    }

    // Also update for the quiz's main topic if not already covered
    const mainTopic = quiz.topic;
    if (mainTopic && !attempt.topicBreakdown?.some(t => t.topic === mainTopic)) {
      let topicEntry = profile.topicMastery.find(t => t.topic === mainTopic);
      const score = attempt.score?.percentage || 0;

      if (topicEntry) {
        topicEntry.score = Math.round(score * 0.6 + topicEntry.score * 0.4);
        topicEntry.level = this._scoreToLevel(topicEntry.score);
        topicEntry.quizzesTaken += 1;
        topicEntry.lastAssessedAt = new Date();
        topicEntry.scoreHistory.push({ score, date: new Date(), quizId: quiz._id });
        topicEntry.trend = this._calculateTrend(topicEntry.scoreHistory);
      } else {
        profile.topicMastery.push({
          topic: mainTopic,
          score,
          level: this._scoreToLevel(score),
          quizzesTaken: 1,
          lastAssessedAt: new Date(),
          scoreHistory: [{ score, date: new Date(), quizId: quiz._id }],
          trend: 'stable',
        });
      }
    }

    // Recalculate aggregates
    const allTopics = profile.topicMastery;
    profile.totalTopicsCovered = allTopics.length;
    profile.totalQuizzesTaken += 1;
    profile.overallScore = allTopics.length > 0
      ? Math.round(allTopics.reduce((sum, t) => sum + t.score, 0) / allTopics.length)
      : 0;
    profile.strengths = allTopics
      .filter(t => t.score >= 70)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(t => t.topic);
    profile.weaknesses = allTopics
      .filter(t => t.score < 50 && t.quizzesTaken > 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 10)
      .map(t => t.topic);

    profile.lastUpdatedAt = new Date();
    await profile.save();

    // Trigger journey adaptation based on quiz results
    const quizScore = attempt.score?.percentage || 0;
    await journeyAdaptationQueue.add('adapt', {
      userId: userId.toString(),
      trigger: 'quiz_completed',
      data: { topic: quiz.topic, score: quizScore, attemptId: attemptId.toString() },
    });

    return profile;
  }

  /**
   * Get full knowledge profile for a user.
   */
  async getProfile(userId) {
    let profile = await KnowledgeProfile.findOne({ userId });
    if (!profile) {
      profile = await KnowledgeProfile.create({ userId, topicMastery: [] });
    }
    return profile;
  }

  /**
   * Get detailed info for a specific topic.
   */
  async getTopicDetail(userId, topic) {
    const profile = await KnowledgeProfile.findOne({ userId });
    if (!profile) return { topic, score: 0, level: 'not_started', quizzesTaken: 0, scoreHistory: [] };

    const entry = profile.topicMastery.find(t => t.topic === topic.toLowerCase());
    if (!entry) return { topic, score: 0, level: 'not_started', quizzesTaken: 0, scoreHistory: [] };

    return {
      topic: entry.topic,
      score: entry.score,
      level: entry.level,
      quizzesTaken: entry.quizzesTaken,
      trend: entry.trend,
      lastAssessedAt: entry.lastAssessedAt,
      scoreHistory: entry.scoreHistory,
    };
  }

  /**
   * Get knowledge gaps — topics with low scores.
   */
  async getGaps(userId) {
    const profile = await KnowledgeProfile.findOne({ userId });
    if (!profile) return [];

    return profile.topicMastery
      .filter(t => t.score < 50 && t.quizzesTaken > 0)
      .sort((a, b) => a.score - b.score)
      .map(t => ({
        topic: t.topic,
        score: t.score,
        level: t.level,
        quizzesTaken: t.quizzesTaken,
        suggestion: t.score < 20
          ? `Start with foundational content on ${t.topic}`
          : `Review and practice more on ${t.topic}`,
      }));
  }

  /**
   * Get strengths — topics with high scores.
   */
  async getStrengths(userId) {
    const profile = await KnowledgeProfile.findOne({ userId });
    if (!profile) return [];

    return profile.topicMastery
      .filter(t => t.score >= 70)
      .sort((a, b) => b.score - a.score)
      .map(t => ({
        topic: t.topic,
        score: t.score,
        level: t.level,
        trend: t.trend,
      }));
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  _scoreToLevel(score) {
    if (score >= 90) return 'expert';
    if (score >= 70) return 'advanced';
    if (score >= 50) return 'intermediate';
    if (score >= 20) return 'beginner';
    return 'not_started';
  }

  _calculateTrend(scoreHistory) {
    if (!scoreHistory || scoreHistory.length < 2) return 'stable';

    const recent = scoreHistory.slice(-3);
    if (recent.length < 2) return 'stable';

    const first = recent[0].score;
    const last = recent[recent.length - 1].score;
    const diff = last - first;

    if (diff > 5) return 'improving';
    if (diff < -5) return 'declining';
    return 'stable';
  }
}

module.exports = new KnowledgeService();
