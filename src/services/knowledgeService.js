const KnowledgeProfile = require('../models/KnowledgeProfile');
const QuizAttempt = require('../models/QuizAttempt');
const Quiz = require('../models/Quiz');
const { journeyAdaptationQueue } = require('../config/queue');

const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];

/**
 * Bump or drop a topic's targetDifficulty based on the per-topic quiz percentage.
 * ≥85% → upgrade (capped at 'hard')
 * ≤40% → downgrade (floored at 'easy')
 * Otherwise → unchanged
 */
function adjustTargetDifficulty(currentDifficulty, percentage) {
  const current = currentDifficulty || 'medium';
  const idx = DIFFICULTY_ORDER.indexOf(current);
  if (idx < 0) return current;
  if (percentage >= 85 && idx < DIFFICULTY_ORDER.length - 1) {
    return DIFFICULTY_ORDER[idx + 1];
  }
  if (percentage <= 40 && idx > 0) {
    return DIFFICULTY_ORDER[idx - 1];
  }
  return current;
}

class KnowledgeService {

  /**
   * Update topic mastery from a quiz-like attempt.
   *
   * This is the shared core used by updateFromQuizAttempt (source='quiz')
   * and by completeChallenge (source='competition').  Callers that don't
   * care about weighting can omit opts entirely — defaults preserve the
   * existing 60/40 blend behaviour.
   *
   * @param {string} userId
   * @param {Array<{topic: string, correct: number, total: number, percentage: number}>} topicBreakdown
   * @param {{
   *   source?: 'quiz'|'competition'|'interview',
   *   weight?: number,
   *   quizRef?: object,        // { _id, objectiveId, topic } — passed in by updateFromQuizAttempt
   *   incrementQuizCount?: boolean,
   *   triggerAdaptation?: boolean,
   *   adaptationPayload?: object,
   * }} [opts]
   *   - source: documents where the update came from (logged only).
   *   - weight: multiplier on the new-score contribution.
   *       Defaults: quiz=1.0, interview=1.0, competition=0.5, unknown=1.0
   *       At weight=1.0 the formula is the original 60% new / 40% old.
   *       At weight=0.5 the new score pulls only half as hard:
   *         blended = (newScore * 0.6 * w + oldScore * 0.4) / (0.6 * w + 0.4)
   */
  async updateMastery(userId, topicBreakdown, opts = {}) {
    const source = opts.source || 'quiz';
    const defaultWeight = source === 'competition' ? 0.5 : 1.0;
    const weight = typeof opts.weight === 'number' ? opts.weight : defaultWeight;
    const quizRef = opts.quizRef || null;        // { _id, objectiveId, topic }
    const incrementQuizCount = opts.incrementQuizCount !== false;

    console.log(`[KnowledgeService] updateMastery source=${source} weight=${weight} userId=${userId} topics=${topicBreakdown.length}`);

    let profile = await KnowledgeProfile.findOne({ userId });
    if (!profile) {
      profile = await KnowledgeProfile.create({ userId, topicMastery: [], _processedAttempts: [] });
    }

    // Update per-topic mastery from the topic breakdown
    const difficultyUpgrades = [];
    for (const breakdown of (topicBreakdown || [])) {
      const newScore = breakdown.percentage;
      let topicEntry = profile.topicMastery.find(t => t.topic === breakdown.topic);

      if (topicEntry) {
        // Weighted blend: normally 60% new / 40% old.  The `weight` multiplier
        // scales how much this attempt's score contributes to the blend.
        // Formula: (newScore * 0.6 * w + oldScore * 0.4) / (0.6 * w + 0.4)
        const oldScore = topicEntry.score;
        const newContrib = 0.6 * weight;
        topicEntry.score = Math.round((newScore * newContrib + oldScore * 0.4) / (newContrib + 0.4));
        topicEntry.level = this._scoreToLevel(topicEntry.score);
        topicEntry.quizzesTaken += 1;
        topicEntry.lastAssessedAt = new Date();
        topicEntry.scoreHistory.push({
          score: newScore,
          date: new Date(),
          quizId: quizRef ? quizRef._id : null,
          objectiveId: quizRef ? (quizRef.objectiveId || null) : null,
          source,
        });
        // Keep last 20 history entries
        if (topicEntry.scoreHistory.length > 20) {
          topicEntry.scoreHistory = topicEntry.scoreHistory.slice(-20);
        }
        topicEntry.trend = this._calculateTrend(topicEntry.scoreHistory);

        // Adjust targetDifficulty based on this quiz's per-topic score
        const oldTargetDifficulty = topicEntry.targetDifficulty || 'medium';
        const newTargetDifficulty = adjustTargetDifficulty(oldTargetDifficulty, newScore);
        topicEntry.targetDifficulty = newTargetDifficulty;
        if (newTargetDifficulty !== oldTargetDifficulty) {
          difficultyUpgrades.push({ topic: breakdown.topic, from: oldTargetDifficulty, to: newTargetDifficulty });
        }
      } else {
        // First encounter: for weight < 1, scale the initial score proportionally
        // so a low-confidence source doesn't anchor the topic at full value.
        const initialScore = weight < 1.0 ? Math.round(newScore * weight) : newScore;
        const initialDifficulty = adjustTargetDifficulty('medium', newScore);
        profile.topicMastery.push({
          topic: breakdown.topic,
          score: initialScore,
          level: this._scoreToLevel(initialScore),
          quizzesTaken: 1,
          lastAssessedAt: new Date(),
          scoreHistory: [{
            score: newScore,
            date: new Date(),
            quizId: quizRef ? quizRef._id : null,
            objectiveId: quizRef ? (quizRef.objectiveId || null) : null,
            source,
          }],
          trend: 'stable',
          objectiveId: quizRef ? (quizRef.objectiveId || null) : null,
          targetDifficulty: initialDifficulty,
        });
        if (initialDifficulty !== 'medium') {
          difficultyUpgrades.push({ topic: breakdown.topic, from: 'medium', to: initialDifficulty });
        }
      }
    }

    // Recalculate aggregates
    const allTopics = profile.topicMastery;
    profile.totalTopicsCovered = allTopics.length;
    if (incrementQuizCount) profile.totalQuizzesTaken += 1;
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

    return { profile, allTopics, difficultyUpgrades };
  }

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

    // Build the full topicBreakdown: per-topic rows + quiz main topic if missing
    let breakdown = [...(attempt.topicBreakdown || [])];
    const mainTopic = quiz.topic;
    if (mainTopic && !breakdown.some(t => t.topic === mainTopic)) {
      const score = attempt.score?.percentage || 0;
      breakdown.push({ topic: mainTopic, correct: 0, total: 0, percentage: score });
    }

    // Delegate to updateMastery (source='quiz', weight=1.0 — original behaviour)
    let difficultyUpgrades;
    ({ profile, difficultyUpgrades } = await this.updateMastery(userId, breakdown, {
      source: 'quiz',
      weight: 1.0,
      quizRef: { _id: quiz._id, objectiveId: quiz.objectiveId, topic: quiz.topic },
      incrementQuizCount: true,
    }));

    // Persist upgrades onto the attempt so getResults can surface them to the client
    if (difficultyUpgrades && difficultyUpgrades.length > 0) {
      await QuizAttempt.findByIdAndUpdate(attemptId, {
        $set: { difficultyUpgrades },
      });
      console.log(`[KnowledgeService] difficultyUpgrades for attempt ${attemptIdStr}:`, JSON.stringify(difficultyUpgrades));
    }

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

    // Update plan task progress for quiz completion (best-effort).
    // The task's topic.canonicalName is set at plan-generation time from the
    // same topic taxonomy as the quiz's `topic`, so a string match is correct.
    try {
      const planProgressService = require('./plan/planProgressService');
      await planProgressService.onQuizComplete({
        userId,
        quizId: String(quiz._id),
        attemptId: String(attempt._id),
        topic: quiz.topic,
      });
    } catch (err) {
      console.warn('[knowledgeService] planProgressService.onQuizComplete failed:', err.message);
    }

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

  /**
   * Update knowledge profile from flashcard study session.
   * Flashcards have lighter weight than quizzes (20% influence vs quiz's 60%).
   */
  async updateFromFlashcardStudy(userId, flashcardSetId) {
    const FlashcardSet = require('../models/FlashcardSet');
    const Content = require('../models/Content');

    const set = await FlashcardSet.findById(flashcardSetId);
    if (!set || set.totalCards === 0) return;

    const content = await Content.findById(set.contentId).lean();
    if (!content) return;

    const topic = (content.domain || '').toLowerCase();
    if (!topic) return;

    let profile = await KnowledgeProfile.findOne({ userId });
    if (!profile) {
      profile = await KnowledgeProfile.create({ userId, topicMastery: [], _processedAttempts: [] });
    }

    const masteryPercent = Math.round((set.masteredCount / set.totalCards) * 100);
    let topicEntry = profile.topicMastery.find(t => t.topic === topic);

    if (topicEntry) {
      // Light influence: 20% flashcard score, 80% existing
      topicEntry.score = Math.round(masteryPercent * 0.2 + topicEntry.score * 0.8);
      topicEntry.level = this._scoreToLevel(topicEntry.score);
      topicEntry.lastAssessedAt = new Date();
    } else {
      // First interaction with this topic via flashcards — start at lower weight
      profile.topicMastery.push({
        topic,
        score: Math.round(masteryPercent * 0.3), // Lower starting weight for flashcard-only
        level: this._scoreToLevel(Math.round(masteryPercent * 0.3)),
        quizzesTaken: 0,
        lastAssessedAt: new Date(),
        scoreHistory: [],
        trend: 'stable',
      });
    }

    // Recalculate aggregates
    const allTopics = profile.topicMastery;
    profile.totalTopicsCovered = allTopics.length;
    profile.overallScore = allTopics.length > 0
      ? Math.round(allTopics.reduce((sum, t) => sum + t.score, 0) / allTopics.length)
      : 0;

    await profile.save();
    return profile;
  }

  /**
   * Update knowledge profile from interview evaluation results.
   * Interviews have moderate weight (40% new, 60% old) — less than quizzes.
   */
  async updateFromInterview(sessionId, userId, objectiveId) {
    const InterviewSession = require('../models/InterviewSession');
    const session = await InterviewSession.findById(sessionId);
    if (!session || session.status !== 'evaluated' || !session.evaluation) return;

    let profile = await KnowledgeProfile.findOne({ userId });
    if (!profile) {
      profile = await KnowledgeProfile.create({ userId, topicMastery: [], _processedAttempts: [] });
    }

    // Idempotency
    const key = `interview_${sessionId}`;
    if (!profile._processedAttempts) profile._processedAttempts = [];
    if (profile._processedAttempts.includes(key)) return profile;

    const eval_ = session.evaluation;
    const typeLabel = session.interviewType.replace(/_/g, ' ');

    // Update topic mastery for interview dimensions
    const dimensions = [
      { topic: `${typeLabel}: communication`, score: eval_.communication?.score || 0 },
      { topic: `${typeLabel}: content`, score: eval_.content?.score || 0 },
      { topic: `${typeLabel}: structure`, score: eval_.structure?.score || 0 },
      { topic: `${typeLabel}: confidence`, score: eval_.confidence?.score || 0 },
    ];

    // Also add an overall topic for the interview type
    dimensions.push({ topic: `interview: ${typeLabel}`, score: eval_.overallScore || 0 });

    for (const dim of dimensions) {
      let topicEntry = profile.topicMastery.find(t => t.topic === dim.topic);
      if (topicEntry) {
        topicEntry.score = Math.round(dim.score * 0.4 + topicEntry.score * 0.6);
        topicEntry.level = this._scoreToLevel(topicEntry.score);
        topicEntry.quizzesTaken += 1;
        topicEntry.lastAssessedAt = new Date();
        topicEntry.scoreHistory.push({
          score: dim.score, date: new Date(),
          quizId: null, interviewSessionId: session._id,
          objectiveId: objectiveId || null,
        });
        if (topicEntry.scoreHistory.length > 20) {
          topicEntry.scoreHistory = topicEntry.scoreHistory.slice(-20);
        }
        topicEntry.trend = this._calculateTrend(topicEntry.scoreHistory);
      } else {
        profile.topicMastery.push({
          topic: dim.topic, score: dim.score,
          level: this._scoreToLevel(dim.score),
          quizzesTaken: 1, lastAssessedAt: new Date(),
          scoreHistory: [{ score: dim.score, date: new Date(), quizId: null, interviewSessionId: session._id, objectiveId: objectiveId || null }],
          trend: 'stable', objectiveId: objectiveId || null,
        });
      }
    }

    // Recalculate aggregates
    const allTopics = profile.topicMastery;
    profile.totalTopicsCovered = allTopics.length;
    profile.overallScore = allTopics.length > 0
      ? Math.round(allTopics.reduce((sum, t) => sum + t.score, 0) / allTopics.length)
      : 0;
    profile.strengths = allTopics.filter(t => t.score >= 70).sort((a, b) => b.score - a.score).slice(0, 10).map(t => t.topic);
    profile.weaknesses = allTopics.filter(t => t.score < 50 && t.quizzesTaken > 0).sort((a, b) => a.score - b.score).slice(0, 10).map(t => t.topic);

    profile._processedAttempts.push(key);
    if (profile._processedAttempts.length > 200) {
      profile._processedAttempts = profile._processedAttempts.slice(-200);
    }

    profile.lastUpdatedAt = new Date();
    await profile.save();

    // Trigger journey adaptation
    await journeyAdaptationQueue.add('adapt', {
      userId: userId.toString(),
      trigger: 'interview_completed',
      data: { interviewType: session.interviewType, score: eval_.overallScore, sessionId: sessionId.toString() },
    });

    return profile;
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
