const openai = require('../config/openai');
const DailyChallenge = require('../models/DailyChallenge');
const LiveEvent = require('../models/LiveEvent');
const UserObjective = require('../models/UserObjective');
const normalizeTopic = require('../utils/normalizeTopic');

const GENERATION_PROMPT = `You are an expert educational assessment creator for competitive daily quizzes.

Generate questions for a daily learning challenge. These questions will be the SAME for all participants, so they must be:
1. Unambiguous — exactly one clearly correct answer
2. Self-contained — no external context needed
3. Fair — testable through reasoning, not obscure memorization
4. Varied — mix of recall, application, and analytical questions
5. Exactly 4 options (A, B, C, D)
6. Conceptual only — no code snippets or programming output questions
7. Naturally varied in complexity — some straightforward, some requiring deeper thinking

CRITICAL: Generate EXACTLY the number of questions specified. Not fewer, not more.

Return valid JSON with a "questions" array where each question has:
- questionText, questionType (recall | application | conceptual | critical_thinking),
  options (array of {label, text}), correctAnswer (A/B/C/D),
  explanation, concept`;

const MAX_SUBTOPICS = 20;
const MAX_RETRIES = 2;

class ChallengeGenerationService {

  async generateAndActivateDaily() {
    const results = { daily: [], liveEvents: [], errors: [] };

    const objectives = await this._getActiveObjectives();
    console.log(`[ChallengeGen] ${objectives.length} active objectives found`);

    const yesterday = this._dateOffset(-1);
    await DailyChallenge.updateMany(
      { date: yesterday, status: 'active' },
      { status: 'closed' }
    );

    const today = this._todayIST();

    for (const objective of objectives) {
      try {
        const subTopics = await this._getSubTopicsForObjective(objective);
        const exclusions = await this._getLast7DaysQuestions(objective);
        const questions = await this._generateQuestions(objective, subTopics, exclusions, 15);

        const challenge = await DailyChallenge.create({
          topic: objective,
          date: today,
          questions,
          status: 'active',
          timeLimitSeconds: 720,
          activatesAt: today,
          closesAt: new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1),
        });

        results.daily.push({ topic: objective, challengeId: challenge._id });
        console.log(`[ChallengeGen] Daily challenge created for "${objective}"`);
      } catch (err) {
        console.error(`[ChallengeGen] Daily failed for "${objective}":`, err.message);
        results.errors.push({ topic: objective, type: 'daily', error: err.message });
      }
    }

    const dayOfWeek = this._getDayOfWeekIST();
    const isLiveEventEve = [0, 2, 4].includes(dayOfWeek);

    if (isLiveEventEve) {
      const tomorrow = this._dateOffset(1);
      const tomorrowAt8PM = new Date(tomorrow);
      tomorrowAt8PM.setUTCHours(14, 30, 0, 0);

      for (const objective of objectives) {
        try {
          const subTopics = await this._getSubTopicsForObjective(objective);
          const todayChallenge = await DailyChallenge.findOne({ topic: objective, date: today });
          const exclusions = await this._getLast7DaysQuestions(objective);
          if (todayChallenge) {
            exclusions.push(...todayChallenge.questions.map(q => q.questionText));
          }

          const questions = await this._generateQuestions(objective, subTopics, exclusions, 15);

          const event = await LiveEvent.create({
            topic: objective,
            scheduledAt: tomorrowAt8PM,
            questions,
            status: 'scheduled',
          });

          results.liveEvents.push({ topic: objective, eventId: event._id });
          console.log(`[ChallengeGen] Live event created for "${objective}" at ${tomorrowAt8PM.toISOString()}`);
        } catch (err) {
          console.error(`[ChallengeGen] Live event failed for "${objective}":`, err.message);
          results.errors.push({ topic: objective, type: 'liveEvent', error: err.message });
        }
      }
    }

    return results;
  }

  _deriveObjectiveTopic(obj) {
    switch (obj.objectiveType) {
      case 'upskilling':
        return obj.specifics?.targetSkill || null;
      case 'interview_preparation':
        return obj.specifics?.targetRole || null;
      case 'exam_preparation':
        return obj.specifics?.examName || null;
      case 'career_switch':
        return obj.specifics?.toDomain || null;
      default:
        return obj.topicsOfInterest?.[0] || null;
    }
  }

  async _getActiveObjectives() {
    const objectives = await UserObjective.find(
      { status: 'active' },
      { objectiveType: 1, specifics: 1, topicsOfInterest: 1 }
    ).lean();

    const topics = new Set();
    for (const obj of objectives) {
      const topic = normalizeTopic(this._deriveObjectiveTopic(obj));
      if (topic) topics.add(topic);
    }
    return [...topics];
  }

  async _getSubTopicsForObjective(objective) {
    const objectives = await UserObjective.find(
      { status: 'active' },
      { objectiveType: 1, specifics: 1, topicsOfInterest: 1 }
    ).lean();

    const subTopics = new Set();
    for (const obj of objectives) {
      const derived = normalizeTopic(this._deriveObjectiveTopic(obj));
      if (derived === objective && obj.topicsOfInterest) {
        for (const t of obj.topicsOfInterest) {
          const normalized = normalizeTopic(t);
          if (normalized) subTopics.add(normalized);
        }
      }
    }

    const result = [...subTopics].slice(0, MAX_SUBTOPICS);
    return result.length > 0 ? result : [objective];
  }

  async _getLast7DaysQuestions(objective) {
    const sevenDaysAgo = this._dateOffset(-7);
    const challenges = await DailyChallenge.find({
      topic: objective,
      date: { $gte: sevenDaysAgo },
    }).lean();

    return challenges.flatMap(c => c.questions.map(q => q.questionText));
  }

  async _generateQuestions(objective, subTopics, exclusions, count) {
    const subTopicStr = subTopics.join(', ');
    const exclusionStr = exclusions.length > 0
      ? `\n\nDo NOT repeat any of these previously used questions:\n${exclusions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : '';

    const userMessage = JSON.stringify({
      topic: objective,
      subTopics: subTopicStr,
      questionCount: count,
    }) + exclusionStr;

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = attempt === 1 ? 1000 : 3000;
          await new Promise(r => setTimeout(r, delay));
          console.log(`[ChallengeGen] Retry ${attempt} for "${objective}"`);
        }

        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: GENERATION_PROMPT },
            { role: 'user', content: userMessage },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.7,
          max_tokens: count * 500,
        });

        const parsed = JSON.parse(response.choices[0].message.content);
        if (!parsed.questions || !Array.isArray(parsed.questions) || parsed.questions.length < count) {
          throw new Error(`Expected ${count} questions, got ${parsed.questions?.length || 0}`);
        }

        return parsed.questions.slice(0, count);
      } catch (err) {
        lastError = err;
        console.error(`[ChallengeGen] Attempt ${attempt + 1} failed for "${objective}":`, err.message);
      }
    }

    throw new Error(`All ${MAX_RETRIES + 1} generation attempts failed for "${objective}": ${lastError?.message}`);
  }

  _todayIST() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    return new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
  }

  _dateOffset(days) {
    const today = this._todayIST();
    return new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
  }

  _getDayOfWeekIST() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    return istNow.getUTCDay();
  }
}

module.exports = new ChallengeGenerationService();
