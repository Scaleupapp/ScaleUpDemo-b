// src/services/competitionService.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const DailyChallenge = require('../models/DailyChallenge');
const ChallengeAttempt = require('../models/ChallengeAttempt');
const WeeklyLeaderboard = require('../models/WeeklyLeaderboard');
const CompetitionProfile = require('../models/CompetitionProfile');
const KnowledgeProfile = require('../models/KnowledgeProfile');

const DIFFICULTY_WEIGHTS = { easy: 0.8, medium: 1.0, hard: 1.3 };
const LEVEL_BONUS = { beginner: 1.20, intermediate: 1.10, advanced: 1.00, expert: 0.95 };
const TIERED_TIME_LIMITS = { easy: 20, medium: 35, hard: 45 };

class CompetitionService {

  // --- Randomization ---

  generateQuestionOrder(userId, challengeId, questionCount) {
    const seed = crypto.createHash('sha256').update(`${userId}${challengeId}`).digest('hex');
    const indices = Array.from({ length: questionCount }, (_, i) => i);
    let seedNum = parseInt(seed.substring(0, 8), 16);
    for (let i = indices.length - 1; i > 0; i--) {
      seedNum = (seedNum * 1103515245 + 12345) & 0x7fffffff;
      const j = seedNum % (i + 1);
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
  }

  generateOptionOrders(userId, challengeId, questions) {
    const baseSeed = crypto.createHash('sha256').update(`${userId}${challengeId}opts`).digest('hex');
    return questions.map((_, qIdx) => {
      const labels = ['A', 'B', 'C', 'D'];
      let seedNum = parseInt(baseSeed.substring(qIdx * 2, qIdx * 2 + 8), 16);
      for (let i = labels.length - 1; i > 0; i--) {
        seedNum = (seedNum * 1103515245 + 12345) & 0x7fffffff;
        const j = seedNum % (i + 1);
        [labels[i], labels[j]] = [labels[j], labels[i]];
      }
      return labels;
    });
  }

  // --- Scoring ---

  calculateHandicappedScore(rawScore, questions, userLevel) {
    const avgDifficulty = questions.reduce((sum, q) => sum + (DIFFICULTY_WEIGHTS[q.difficulty] || 1.0), 0) / questions.length;
    const levelBonus = LEVEL_BONUS[userLevel] || 1.0;
    return rawScore * avgDifficulty * levelBonus;
  }

  calculateSpeedBonus(userAvgTime, medianTime) {
    if (medianTime <= 0) return 0;
    if (userAvgTime >= medianTime) return 0;
    const ratio = 1 - (userAvgTime / medianTime);
    return Math.min(ratio, 0.10);
  }

  // --- Challenge Lifecycle ---

  async getTodayChallenges() {
    const today = this._todayIST();
    return DailyChallenge.find({ date: today, status: 'active' }).select('-questions.correctAnswer -questions.explanation');
  }

  async getChallengeById(challengeId) {
    return DailyChallenge.findById(challengeId);
  }

  async startChallenge(userId, challengeId) {
    const challenge = await DailyChallenge.findById(challengeId);
    if (!challenge || challenge.status !== 'active') {
      throw new Error('Challenge not available');
    }

    const existing = await ChallengeAttempt.findOne({ userId, challengeId });
    if (existing) {
      throw new Error('Already attempted this challenge');
    }

    const questionOrder = this.generateQuestionOrder(userId, challengeId, challenge.questions.length);
    const optionOrders = this.generateOptionOrders(userId, challengeId, challenge.questions);

    const attempt = await ChallengeAttempt.create({
      userId, challengeId, questionOrder, optionOrders, answers: [],
    });

    await DailyChallenge.findByIdAndUpdate(challengeId, { $inc: { participantCount: 1 } });

    const randomizedQuestions = questionOrder.map((origIdx, newIdx) => {
      const q = challenge.questions[origIdx];
      const optOrder = optionOrders[newIdx];
      const shuffledOptions = optOrder.map(label => q.options.find(o => o.label === label));
      return {
        questionIndex: newIdx,
        questionText: q.questionText,
        questionType: q.questionType,
        difficulty: q.difficulty,
        concept: q.concept,
        options: shuffledOptions.map((opt, i) => ({ label: ['A', 'B', 'C', 'D'][i], text: opt.text })),
        timeLimit: TIERED_TIME_LIMITS[q.difficulty] || 35,
      };
    });

    return { attemptId: attempt._id, questions: randomizedQuestions };
  }

  async submitAnswer(userId, challengeId, questionIndex, selectedAnswer, timeSpent) {
    const attempt = await ChallengeAttempt.findOne({ userId, challengeId });
    if (!attempt) throw new Error('No active attempt');
    if (attempt.completedAt) throw new Error('Challenge already completed');

    attempt.answers.push({ questionIndex, selectedAnswer, timeSpent, answeredAt: new Date() });
    await attempt.save();
    return { answersSubmitted: attempt.answers.length };
  }

  async completeChallenge(userId, challengeId) {
    const attempt = await ChallengeAttempt.findOne({ userId, challengeId });
    if (!attempt) throw new Error('No active attempt');
    if (attempt.completedAt) throw new Error('Already completed');

    const challenge = await DailyChallenge.findById(challengeId);
    const profile = await KnowledgeProfile.findOne({ userId });
    const topicMastery = profile?.topicMastery?.find(t => t.topic === challenge.topic);
    const userLevel = topicMastery?.level || 'beginner';

    let correct = 0;
    for (const answer of attempt.answers) {
      const origQuestionIdx = attempt.questionOrder[answer.questionIndex];
      const question = challenge.questions[origQuestionIdx];
      const optOrder = attempt.optionOrders[answer.questionIndex];
      const answerIdx = ['A', 'B', 'C', 'D'].indexOf(answer.selectedAnswer);
      const originalLabel = optOrder[answerIdx];
      if (originalLabel === question.correctAnswer) correct++;
    }

    const rawScore = (correct / challenge.questions.length) * 100;
    const handicappedScore = this.calculateHandicappedScore(rawScore, challenge.questions, userLevel);
    const timeTaken = attempt.answers.reduce((sum, a) => sum + (a.timeSpent || 0), 0);

    let compProfile = await CompetitionProfile.findOne({ userId });
    if (!compProfile) {
      compProfile = await CompetitionProfile.create({ userId });
    }

    const currentBest = compProfile.personalBests?.get(challenge.topic)?.bestDailyScore || 0;
    const isPersonalBest = handicappedScore > currentBest;

    if (isPersonalBest) {
      compProfile.personalBests.set(challenge.topic, {
        ...(compProfile.personalBests.get(challenge.topic) || {}),
        bestDailyScore: handicappedScore,
        bestDailyDate: new Date(),
      });
    }
    compProfile.totalChallengesCompleted += 1;

    await this._updateChallengeStreak(compProfile);
    await compProfile.save();

    attempt.rawScore = rawScore;
    attempt.handicappedScore = handicappedScore;
    attempt.timeTaken = timeTaken;
    attempt.isPersonalBest = isPersonalBest;
    attempt.completedAt = new Date();
    await attempt.save();

    await this._updateWeeklyLeaderboard(userId, challenge.topic, handicappedScore);

    return {
      rawScore, handicappedScore, timeTaken, isPersonalBest,
      correct, total: challenge.questions.length,
      previousBest: currentBest,
    };
  }

  // --- Leaderboard ---

  async getWeeklyLeaderboard(topic = 'global', weekStart = null) {
    const ws = weekStart || this._currentWeekStartIST();
    const board = await WeeklyLeaderboard.findOne({ topic, weekStart: ws })
      .populate('entries.userId', 'firstName lastName username profilePicture');
    return board;
  }

  async getCompetitionProfile(userId) {
    let profile = await CompetitionProfile.findOne({ userId });
    if (!profile) profile = await CompetitionProfile.create({ userId });
    return profile;
  }

  async getCompetitionStats(userId) {
    const profile = await this.getCompetitionProfile(userId);
    const weekStart = this._currentWeekStartIST();

    const board = await WeeklyLeaderboard.findOne({ topic: 'global', weekStart });
    const myEntry = board?.entries?.find(e => e.userId.toString() === userId.toString());

    const todayChallenges = await this.getTodayChallenges();
    const todayAttempts = await ChallengeAttempt.find({
      userId,
      challengeId: { $in: todayChallenges.map(c => c._id) },
      completedAt: { $ne: null },
    });

    return {
      challengeStreak: profile.currentChallengeStreak,
      percentile: myEntry?.percentile || null,
      challengesThisWeek: myEntry?.challengesCompleted || 0,
      personalBests: Object.fromEntries(profile.personalBests || new Map()),
      todayCompleted: todayAttempts.length,
      todayTotal: todayChallenges.length,
    };
  }

  // --- Weekly Leaderboard Update ---

  async _updateWeeklyLeaderboard(userId, topic, handicappedScore) {
    const weekStart = this._currentWeekStartIST();
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

    for (const boardTopic of ['global', topic]) {
      let board = await WeeklyLeaderboard.findOne({ topic: boardTopic, weekStart });
      if (!board) {
        board = await WeeklyLeaderboard.create({ topic: boardTopic, weekStart, weekEnd, entries: [] });
      }

      const entryIdx = board.entries.findIndex(e => e.userId.toString() === userId.toString());
      if (entryIdx >= 0) {
        board.entries[entryIdx].totalHandicappedScore += handicappedScore;
        board.entries[entryIdx].challengesCompleted += 1;
        board.entries[entryIdx].bestDayScore = Math.max(board.entries[entryIdx].bestDayScore, handicappedScore);
      } else {
        board.entries.push({
          userId, totalHandicappedScore: handicappedScore, challengesCompleted: 1, bestDayScore: handicappedScore,
        });
        board.participantCount += 1;
      }

      await board.save();
    }
  }

  // --- Challenge Results ---

  async getChallengeResults(userId, challengeId) {
    const attempt = await ChallengeAttempt.findOne({ userId, challengeId });
    if (!attempt) throw new Error('No attempt found');

    const challenge = await DailyChallenge.findById(challengeId);
    const compProfile = await CompetitionProfile.findOne({ userId });

    const allAttempts = await ChallengeAttempt.find({ challengeId, completedAt: { $ne: null } })
      .sort({ handicappedScore: -1 });
    const rank = allAttempts.findIndex(a => a.userId.toString() === userId.toString()) + 1;
    const totalParticipants = allAttempts.length;
    const percentile = totalParticipants > 0 ? Math.round(((totalParticipants - rank + 1) / totalParticipants) * 100) : null;

    return {
      rawScore: attempt.rawScore,
      handicappedScore: attempt.handicappedScore,
      timeTaken: attempt.timeTaken,
      isPersonalBest: attempt.isPersonalBest,
      correct: attempt.answers.filter((a, idx) => {
        const origIdx = attempt.questionOrder[idx];
        const q = challenge.questions[origIdx];
        const optOrder = attempt.optionOrders[idx];
        const ansIdx = ['A', 'B', 'C', 'D'].indexOf(a.selectedAnswer);
        return optOrder[ansIdx] === q.correctAnswer;
      }).length,
      total: challenge.questions.length,
      rank,
      percentile,
      totalParticipants,
      previousBest: compProfile?.personalBests?.get(challenge.topic)?.bestDailyScore || 0,
    };
  }

  // --- All-Time Leaderboard ---

  async getAllTimeLeaderboard(topic) {
    const boards = await WeeklyLeaderboard.find({
      topic: topic || 'global',
      finalized: true,
    });

    const userScores = {};
    for (const board of boards) {
      for (const entry of board.entries) {
        const uid = entry.userId.toString();
        if (!userScores[uid]) {
          userScores[uid] = { userId: entry.userId, totalScore: 0, totalChallenges: 0 };
        }
        userScores[uid].totalScore += entry.totalHandicappedScore;
        userScores[uid].totalChallenges += entry.challengesCompleted;
      }
    }

    const sorted = Object.values(userScores).sort((a, b) => b.totalScore - a.totalScore);
    sorted.forEach((entry, idx) => { entry.rank = idx + 1; });

    const User = require('../models/User');
    const top50 = sorted.slice(0, 50);
    for (const entry of top50) {
      const user = await User.findById(entry.userId).select('firstName lastName username profilePicture');
      entry.user = user;
    }

    return { entries: top50, topic: topic || 'global' };
  }

  // --- Streak Management ---

  async _updateChallengeStreak(compProfile) {
    const today = this._todayIST();
    let streak = 0;
    let checkDate = today;

    while (true) {
      const challenges = await DailyChallenge.find({ date: checkDate });
      if (challenges.length === 0) break;

      const hasAttempt = await ChallengeAttempt.findOne({
        userId: compProfile.userId,
        challengeId: { $in: challenges.map(c => c._id) },
        completedAt: { $ne: null },
      });

      if (!hasAttempt) break;
      streak++;
      checkDate = new Date(checkDate.getTime() - 24 * 60 * 60 * 1000);
    }

    compProfile.currentChallengeStreak = streak;
    if (streak > compProfile.longestChallengeStreak) {
      compProfile.longestChallengeStreak = streak;
    }
  }

  // --- Helpers ---

  _todayIST() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    return new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
  }

  _currentWeekStartIST() {
    const today = this._todayIST();
    const day = today.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    return new Date(today.getTime() - diff * 24 * 60 * 60 * 1000);
  }
}

module.exports = new CompetitionService();
