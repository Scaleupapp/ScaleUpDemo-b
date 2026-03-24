// src/services/challengeGenerationService.js
const openai = require('../config/openai');
const ChallengeCandidateBank = require('../models/ChallengeCandidateBank');
const DailyChallenge = require('../models/DailyChallenge');
const LiveEvent = require('../models/LiveEvent');
const KnowledgeProfile = require('../models/KnowledgeProfile');

const CHALLENGE_GENERATION_PROMPT = `You are an expert educational assessment creator specializing in standardized competitive quizzes.

Generate questions for a daily learning challenge. These questions will be the SAME for all participants regardless of their skill level, so they must be:
1. Unambiguous — exactly one clearly correct answer
2. Self-contained — no external context needed
3. Fair — testable through reasoning, not obscure memorization
4. Varied — mix of recall, application, and conceptual questions
5. Exactly 4 options (A, B, C, D)

Difficulty distribution: 30% easy, 40% medium, 30% hard.
CRITICAL: Generate EXACTLY the number of questions specified. Not fewer, not more.

Return valid JSON with a "questions" array where each question has:
- questionText, questionType (recall | application | conceptual | critical_thinking),
  options (array of {label, text}), correctAnswer (A/B/C/D),
  explanation, difficulty (easy | medium | hard), concept`;

class ChallengeGenerationService {

  async generateWeeklyCandidates() {
    const profiles = await KnowledgeProfile.find({ 'topicMastery.0': { $exists: true } });
    const activeTopics = [...new Set(profiles.flatMap(p => p.topicMastery.map(t => t.topic)))];

    console.log(`[ChallengeGen] Generating candidates for ${activeTopics.length} topics`);

    const weekOf = this._nextMondayIST();
    const results = [];

    for (const topic of activeTopics) {
      try {
        const candidates = await this._generateForTopic(topic, 130);
        const bank = await ChallengeCandidateBank.create({
          topic, weekOf, candidates, status: 'pending_review',
        });
        results.push({ topic, count: candidates.length, bankId: bank._id });
        console.log(`[ChallengeGen] Generated ${candidates.length} candidates for "${topic}"`);
      } catch (err) {
        console.error(`[ChallengeGen] Failed for "${topic}":`, err.message);
        results.push({ topic, error: err.message });
      }
    }

    return results;
  }

  async _generateForTopic(topic, totalCount) {
    const batchSize = 20;
    const batches = Math.ceil(totalCount / batchSize);
    let allQuestions = [];

    for (let i = 0; i < batches; i++) {
      const remaining = totalCount - allQuestions.length;
      const count = Math.min(batchSize, remaining);

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: CHALLENGE_GENERATION_PROMPT },
          { role: 'user', content: JSON.stringify({ topic, questionCount: count }) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: count * 500,
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      if (parsed.questions && Array.isArray(parsed.questions)) {
        allQuestions.push(...parsed.questions);
      }
    }

    return allQuestions;
  }

  async autoAssignQuestions(bankId) {
    const bank = await ChallengeCandidateBank.findById(bankId);
    if (!bank) throw new Error('Candidate bank not found');

    const unassigned = bank.candidates.filter(c => !c.assignedTo);
    const weekOf = bank.weekOf;

    // Assign 10 per day for 7 daily challenges
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekOf.getTime() + day * 24 * 60 * 60 * 1000);
      const selected = this._selectBalanced(unassigned.filter(c => !c.assignedTo), 10);
      selected.forEach(q => { q.assignedTo = 'daily'; q.assignedDate = date; });
    }

    // Assign 10 per live event for 3 events (Mon/Wed/Fri)
    const liveEventDays = [0, 2, 4];
    for (const dayOffset of liveEventDays) {
      const date = new Date(weekOf.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const selected = this._selectBalanced(unassigned.filter(c => !c.assignedTo), 10);
      selected.forEach(q => { q.assignedTo = 'live'; q.assignedDate = date; });
    }

    bank.status = 'curated';
    bank.curatedAt = new Date();
    await bank.save();
    return bank;
  }

  _selectBalanced(pool, count) {
    const byDifficulty = { easy: [], medium: [], hard: [] };
    pool.forEach(q => {
      if (byDifficulty[q.difficulty]) byDifficulty[q.difficulty].push(q);
    });

    const selected = [];
    const targets = { easy: 3, medium: 4, hard: 3 };
    for (const [diff, target] of Object.entries(targets)) {
      const available = byDifficulty[diff].filter(q => !selected.includes(q));
      selected.push(...available.slice(0, target));
    }

    while (selected.length < count) {
      const remaining = pool.find(q => !selected.includes(q));
      if (!remaining) break;
      selected.push(remaining);
    }

    return selected.slice(0, count);
  }

  async activateDailyChallenge(date) {
    const dateObj = date || this._todayIST();
    const banks = await ChallengeCandidateBank.find({
      weekOf: { $lte: dateObj },
      status: { $in: ['curated', 'used'] },
    });

    const results = [];
    for (const bank of banks) {
      const dailyQuestions = bank.candidates.filter(c =>
        c.assignedTo === 'daily' &&
        c.assignedDate &&
        c.assignedDate.toDateString() === dateObj.toDateString()
      );

      if (dailyQuestions.length < 10) continue;

      const istMidnight = new Date(dateObj);
      const istEndOfDay = new Date(dateObj.getTime() + 24 * 60 * 60 * 1000 - 1);

      const challenge = await DailyChallenge.create({
        topic: bank.topic,
        date: dateObj,
        questions: dailyQuestions.slice(0, 10),
        status: 'active',
        createdFrom: bank._id,
        activatesAt: istMidnight,
        closesAt: istEndOfDay,
      });

      results.push({ topic: bank.topic, challengeId: challenge._id });
    }

    // Close yesterday's challenges
    const yesterday = new Date(dateObj.getTime() - 24 * 60 * 60 * 1000);
    await DailyChallenge.updateMany(
      { date: yesterday, status: 'active' },
      { status: 'closed' }
    );

    return results;
  }

  _todayIST() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    return new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
  }

  _nextMondayIST() {
    const today = this._todayIST();
    const day = today.getUTCDay();
    const daysUntilMonday = day === 0 ? 1 : 8 - day;
    return new Date(today.getTime() + daysUntilMonday * 24 * 60 * 60 * 1000);
  }
}

module.exports = new ChallengeGenerationService();
