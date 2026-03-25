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

const TITLE_PROMPT = `Generate a short, professional display title for a daily learning challenge about the given topic.

Rules:
- Title Case formatting (capitalize major words)
- 2-5 words maximum
- Professional and engaging, like a course module title
- Do NOT include words like "Quiz", "Challenge", "Test", or "Daily"
- Examples: "Product Strategy & Growth", "Advanced Python Patterns", "Data Science Essentials", "Cloud Architecture Fundamentals"

Return ONLY the title text, nothing else.`;

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

    // Generate display titles for all topics in parallel
    const titleMap = {};
    await Promise.all(objectives.map(async (objective) => {
      try {
        titleMap[objective] = await this._generateDisplayTitle(objective);
      } catch (err) {
        console.error(`[ChallengeGen] Title generation failed for "${objective}":`, err.message);
        titleMap[objective] = this._fallbackTitleCase(objective);
      }
    }));

    for (const objective of objectives) {
      try {
        const subTopics = await this._getSubTopicsForObjective(objective);
        const exclusions = await this._getLast7DaysQuestions(objective);
        const questions = await this._generateQuestions(objective, subTopics, exclusions, 15);

        const challenge = await DailyChallenge.create({
          topic: objective,
          displayTitle: titleMap[objective],
          date: today,
          questions,
          status: 'active',
          timeLimitSeconds: 720,
          activatesAt: today,
          closesAt: new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1),
        });

        results.daily.push({ topic: objective, challengeId: challenge._id });
        console.log(`[ChallengeGen] Daily challenge created for "${objective}" → "${titleMap[objective]}"`);
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
            displayTitle: titleMap[objective],
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

  async _generateDisplayTitle(topic) {
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: TITLE_PROMPT },
          { role: 'user', content: topic },
        ],
        temperature: 0.6,
        max_tokens: 30,
      });
      const title = response.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
      return title || this._fallbackTitleCase(topic);
    } catch (err) {
      return this._fallbackTitleCase(topic);
    }
  }

  _fallbackTitleCase(text) {
    const smallWords = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
    return text.split(' ').map((word, i) => {
      const lower = word.toLowerCase();
      if (i > 0 && smallWords.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join(' ');
  }
}

module.exports = new ChallengeGenerationService();
