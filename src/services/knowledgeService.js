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
      profile = await KnowledgeProfile.create({ userId, topicMastery: [], _processedAttempts: [] });
    }

    // Idempotency guard: skip if this attempt was already processed
    const attemptIdStr = attemptId.toString();
    if (profile._processedAttempts && profile._processedAttempts.includes(attemptIdStr)) {
      console.log(`[KnowledgeService] Skipping already-processed attempt ${attemptIdStr}`);
      return profile;
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
          objectiveId: quiz.objectiveId || null,
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
          scoreHistory: [{ score: newScore, date: new Date(), quizId: quiz._id, objectiveId: quiz.objectiveId || null }],
          trend: 'stable',
          objectiveId: quiz.objectiveId || null,
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
        topicEntry.scoreHistory.push({ score, date: new Date(), quizId: quiz._id, objectiveId: quiz.objectiveId || null });
        topicEntry.trend = this._calculateTrend(topicEntry.scoreHistory);
      } else {
        profile.topicMastery.push({
          topic: mainTopic,
          score,
          level: this._scoreToLevel(score),
          quizzesTaken: 1,
          lastAssessedAt: new Date(),
          scoreHistory: [{ score, date: new Date(), quizId: quiz._id, objectiveId: quiz.objectiveId || null }],
          trend: 'stable',
          objectiveId: quiz.objectiveId || null,
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

    // ── Compute Learning Velocity ────────────────────────────────────
    await this._computeLearningVelocity(profile, userId);

    // ── Compute Behavioral Profile ───────────────────────────────────
    await this._computeBehavioralProfile(profile, userId);

    // Mark this attempt as processed (idempotency)
    if (!profile._processedAttempts) profile._processedAttempts = [];
    profile._processedAttempts.push(attemptIdStr);
    // Keep only last 200 to prevent unbounded growth
    if (profile._processedAttempts.length > 200) {
      profile._processedAttempts = profile._processedAttempts.slice(-200);
    }

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

    // Reconcile totalQuizzesTaken against actual completed attempts
    const actualCount = await QuizAttempt.countDocuments({ userId, status: 'completed' });
    if (profile.totalQuizzesTaken !== actualCount) {
      console.log(`[KnowledgeService] Reconciling totalQuizzesTaken: stored=${profile.totalQuizzesTaken}, actual=${actualCount}`);
      profile.totalQuizzesTaken = actualCount;
      await profile.save();
    }

    // Backfill velocity + behavioral if never computed
    if (profile.topicMastery.length > 0 &&
        profile.learningVelocity?.topicsPerWeek === 0 &&
        profile.learningVelocity?.averageScoreImprovement === 0) {
      await this._computeLearningVelocity(profile, userId);
      await this._computeBehavioralProfile(profile, userId);
      profile.lastUpdatedAt = new Date();
      await profile.save();
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

  // ─── Velocity & Behavioral ─────────────────────────────────────────

  async _computeLearningVelocity(profile, userId) {
    const allTopics = profile.topicMastery;

    // topicsPerWeek: topics with quiz activity in the last 7 days
    const oneWeekAgo = new Date(Date.now() - 7 * 86400000);
    const activeTopicsThisWeek = allTopics.filter(t =>
      t.scoreHistory?.some(h => new Date(h.date) >= oneWeekAgo)
    ).length;
    profile.learningVelocity.topicsPerWeek = activeTopicsThisWeek;

    // averageScoreImprovement: average (last - first) score delta across topics with 2+ history entries
    const deltas = [];
    for (const t of allTopics) {
      if (t.scoreHistory && t.scoreHistory.length >= 2) {
        const first = t.scoreHistory[0].score;
        const last = t.scoreHistory[t.scoreHistory.length - 1].score;
        deltas.push(last - first);
      }
    }
    profile.learningVelocity.averageScoreImprovement = deltas.length > 0
      ? Math.round((deltas.reduce((s, d) => s + d, 0) / deltas.length) * 10) / 10
      : 0;

    // contentToMasteryRatio: total content consumed / topics at intermediate+ level
    const ContentProgress = require('../models/ContentProgress');
    const contentCount = await ContentProgress.countDocuments({ userId, isCompleted: true });
    const masteredTopics = allTopics.filter(t => t.score >= 50).length;
    profile.learningVelocity.contentToMasteryRatio = masteredTopics > 0
      ? Math.round((contentCount / masteredTopics) * 10) / 10
      : 0;
  }

  async _computeBehavioralProfile(profile, userId) {
    const attempts = await QuizAttempt.find({ userId, status: 'completed' })
      .select('answers.timeTaken score.percentage completedAt totalTime')
      .sort({ completedAt: -1 })
      .limit(50)
      .lean();

    if (attempts.length === 0) return;

    // averageAnswerTime: mean of all per-question timeTaken values
    const allTimes = [];
    for (const a of attempts) {
      for (const ans of (a.answers || [])) {
        if (typeof ans.timeTaken === 'number' && ans.timeTaken > 0) {
          allTimes.push(ans.timeTaken);
        }
      }
    }
    profile.behavioralProfile.averageAnswerTime = allTimes.length > 0
      ? Math.round((allTimes.reduce((s, t) => s + t, 0) / allTimes.length) * 10) / 10
      : 0;

    // consistencyScore: 1 - (coefficient of variation of scores), clamped 0–1
    const scores = attempts.map(a => a.score?.percentage || 0);
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const variance = scores.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / scores.length;
    const stddev = Math.sqrt(variance);
    const cv = mean > 0 ? stddev / mean : 1;
    profile.behavioralProfile.consistencyScore = Math.round(Math.max(0, Math.min(1, 1 - cv)) * 100) / 100;

    // peakHours: top 4 most frequent hours from completedAt timestamps
    const hourCounts = {};
    for (const a of attempts) {
      if (a.completedAt) {
        const hour = new Date(a.completedAt).getHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      }
    }
    profile.behavioralProfile.peakHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([h]) => parseInt(h));

    // type: classify based on speed vs accuracy
    const avgSpeed = profile.behavioralProfile.averageAnswerTime;
    const avgAccuracy = mean; // mean percentage score
    if (avgSpeed < 20 && avgAccuracy >= 70) {
      profile.behavioralProfile.type = 'speed_focused';
    } else if (avgSpeed >= 30 && avgAccuracy >= 75) {
      profile.behavioralProfile.type = 'accuracy_focused';
    } else if (avgAccuracy >= 60) {
      profile.behavioralProfile.type = 'balanced';
    } else {
      profile.behavioralProfile.type = 'inconsistent';
    }
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
