// src/services/liveEventService.js
const LiveEvent = require('../models/LiveEvent');
const LiveEventAttempt = require('../models/LiveEventAttempt');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const CompetitionProfile = require('../models/CompetitionProfile');
const ChallengeCandidateBank = require('../models/ChallengeCandidateBank');
const crypto = require('crypto');

const DIFFICULTY_WEIGHTS = { easy: 0.8, medium: 1.0, hard: 1.3 };
const LEVEL_BONUS = { beginner: 1.20, intermediate: 1.10, advanced: 1.00, expert: 0.95 };
const TIERED_TIME_LIMITS = { easy: 20, medium: 35, hard: 45 };

class LiveEventService {

  async getUpcomingEvents() {
    return LiveEvent.find({
      scheduledAt: { $gte: new Date() },
      status: { $in: ['scheduled', 'lobby'] },
    }).sort({ scheduledAt: 1 }).select('-questions.correctAnswer -questions.explanation');
  }

  async getEventById(eventId) {
    return LiveEvent.findById(eventId);
  }

  async joinLobby(userId, eventId) {
    const event = await LiveEvent.findById(eventId);
    if (!event) throw new Error('Event not found');
    if (event.status !== 'lobby') throw new Error('Lobby is not open');

    const existing = await LiveEventAttempt.findOne({ userId, eventId });
    if (existing) return { alreadyJoined: true, participantCount: event.participantCount };

    const questionOrder = this._generateQuestionOrder(userId, eventId, event.questions.length);
    const optionOrders = this._generateOptionOrders(userId, eventId, event.questions);

    await LiveEventAttempt.create({ userId, eventId, questionOrder, optionOrders, answers: [] });
    await LiveEvent.findByIdAndUpdate(eventId, { $inc: { participantCount: 1 } });

    const updated = await LiveEvent.findById(eventId);
    return { alreadyJoined: false, participantCount: updated.participantCount };
  }

  async getLobbyState(eventId) {
    const event = await LiveEvent.findById(eventId).select('status participantCount scheduledAt topic');
    return event;
  }

  async getCurrentQuestion(userId, eventId) {
    const event = await LiveEvent.findById(eventId);
    if (!event || event.status !== 'live') throw new Error('Event is not live');

    const attempt = await LiveEventAttempt.findOne({ userId, eventId });
    if (!attempt) throw new Error('Not joined');

    const now = new Date();
    const elapsed = (now - event.startedAt) / 1000;

    let cumulative = 0;
    let currentIdx = -1;
    const questionTimings = event.questions.map((q, idx) => {
      const origIdx = attempt.questionOrder[idx];
      const timeLimit = TIERED_TIME_LIMITS[event.questions[origIdx].difficulty] || 35;
      const start = cumulative;
      cumulative += timeLimit + 3;
      return { idx, start, end: cumulative, timeLimit };
    });

    const activeTiming = questionTimings.find(t => elapsed >= t.start && elapsed < t.end);
    if (!activeTiming) {
      return { eventComplete: true };
    }

    currentIdx = activeTiming.idx;
    const origIdx = attempt.questionOrder[currentIdx];
    const q = event.questions[origIdx];
    const optOrder = attempt.optionOrders[currentIdx];
    const shuffledOptions = optOrder.map(label => q.options.find(o => o.label === label));

    const timeRemaining = activeTiming.end - elapsed - 3;

    return {
      questionIndex: currentIdx,
      questionText: q.questionText,
      questionType: q.questionType,
      difficulty: q.difficulty,
      options: shuffledOptions.map((opt, i) => ({ label: ['A', 'B', 'C', 'D'][i], text: opt.text })),
      timeLimit: activeTiming.timeLimit,
      timeRemaining: Math.max(0, timeRemaining),
      totalQuestions: event.questions.length,
      eventComplete: false,
    };
  }

  async submitLiveAnswer(userId, eventId, questionIndex, selectedAnswer, timeSpent) {
    const attempt = await LiveEventAttempt.findOne({ userId, eventId });
    if (!attempt) throw new Error('Not joined');

    attempt.answers.push({ questionIndex, selectedAnswer, timeSpent, answeredAt: new Date() });
    await attempt.save();
    return { answersSubmitted: attempt.answers.length };
  }

  async getQuestionResults(eventId, questionIndex) {
    const event = await LiveEvent.findById(eventId);
    const attempts = await LiveEventAttempt.find({ eventId, 'answers.questionIndex': questionIndex });

    let correctCount = 0;
    for (const attempt of attempts) {
      const answer = attempt.answers.find(a => a.questionIndex === questionIndex);
      if (!answer) continue;
      const origIdx = attempt.questionOrder[questionIndex];
      const question = event.questions[origIdx];
      const optOrder = attempt.optionOrders[questionIndex];
      const answerIdx = ['A', 'B', 'C', 'D'].indexOf(answer.selectedAnswer);
      const originalLabel = optOrder[answerIdx];
      if (originalLabel === question.correctAnswer) correctCount++;
    }

    const total = attempts.length || 1;
    return { correctPercentage: Math.round((correctCount / total) * 100), totalAnswered: total };
  }

  async completeLiveEvent(eventId) {
    const event = await LiveEvent.findById(eventId);
    if (!event) throw new Error('Event not found');

    const attempts = await LiveEventAttempt.find({ eventId });
    const leaderboard = [];

    for (const attempt of attempts) {
      if (attempt.answers.length === 0) continue;

      const profile = await KnowledgeProfile.findOne({ userId: attempt.userId });
      const topicMastery = profile?.topicMastery?.find(t => t.topic === event.topic);
      const userLevel = topicMastery?.level || 'beginner';

      let correct = 0;
      for (const answer of attempt.answers) {
        const origIdx = attempt.questionOrder[answer.questionIndex];
        const question = event.questions[origIdx];
        const optOrder = attempt.optionOrders[answer.questionIndex];
        const answerIdx = ['A', 'B', 'C', 'D'].indexOf(answer.selectedAnswer);
        const originalLabel = optOrder[answerIdx];
        if (originalLabel === question.correctAnswer) correct++;
      }

      const rawScore = (correct / event.questions.length) * 100;
      const avgDifficulty = event.questions.reduce((s, q) => s + (DIFFICULTY_WEIGHTS[q.difficulty] || 1), 0) / event.questions.length;
      const handicappedScore = rawScore * avgDifficulty * (LEVEL_BONUS[userLevel] || 1.0);
      const timeTaken = attempt.answers.reduce((s, a) => s + (a.timeSpent || 0), 0);

      attempt.rawScore = rawScore;
      attempt.handicappedScore = handicappedScore;
      attempt.timeTaken = timeTaken;
      attempt.completedAt = new Date();
      await attempt.save();

      leaderboard.push({
        userId: attempt.userId, handicappedScore, rawScore, timeTaken, completedAt: attempt.completedAt,
      });
    }

    leaderboard.sort((a, b) => b.handicappedScore - a.handicappedScore || a.timeTaken - b.timeTaken);
    leaderboard.forEach((entry, idx) => { entry.rank = idx + 1; });

    for (const entry of leaderboard) {
      await LiveEventAttempt.findOneAndUpdate(
        { userId: entry.userId, eventId },
        { rank: entry.rank }
      );
    }

    event.leaderboard = leaderboard;
    event.status = 'completed';
    event.completedAt = new Date();
    event.duration = (event.completedAt - event.startedAt) / 1000;
    await event.save();

    return event;
  }

  async getEventResults(userId, eventId) {
    const event = await LiveEvent.findById(eventId)
      .populate('leaderboard.userId', 'firstName lastName username profilePicture');
    const attempt = await LiveEventAttempt.findOne({ userId, eventId });
    return { event, attempt };
  }

  // --- Randomization helpers ---

  _generateQuestionOrder(userId, eventId, count) {
    const seed = crypto.createHash('sha256').update(`${userId}${eventId}`).digest('hex');
    const indices = Array.from({ length: count }, (_, i) => i);
    let seedNum = parseInt(seed.substring(0, 8), 16);
    for (let i = indices.length - 1; i > 0; i--) {
      seedNum = (seedNum * 1103515245 + 12345) & 0x7fffffff;
      const j = seedNum % (i + 1);
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
  }

  _generateOptionOrders(userId, eventId, questions) {
    const baseSeed = crypto.createHash('sha256').update(`${userId}${eventId}opts`).digest('hex');
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
}

module.exports = new LiveEventService();
