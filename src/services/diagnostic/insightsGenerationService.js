'use strict';

const openai = require('../../config/openai');
const calibration = require('../../utils/calibration');

const DEFAULT_TIMEOUT_MS = 15000;
const MODEL = 'gpt-4o';

const INSIGHTS_JSON_SCHEMA = {
  name: 'diagnostic_insights',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['hero', 'calibration', 'patterns', 'topicTakeaways', 'planHeadline'],
    properties: {
      hero:        { type: 'string', minLength: 10, maxLength: 220 },
      calibration: { type: 'string', minLength: 10, maxLength: 220 },
      patterns: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: { type: 'string', minLength: 10, maxLength: 220 },
      },
      topicTakeaways: {
        type: 'object',
        additionalProperties: { type: 'string', minLength: 5, maxLength: 200 },
      },
      planHeadline: { type: 'string', minLength: 30, maxLength: 600 },
    },
  },
};

function buildSystemPrompt() {
  return [
    'You are ScaleUp\'s diagnostic insights writer.',
    'You help Indian learners understand the gap between how they rated themselves and how they actually performed.',
    'Tone: warm, direct, concrete. Never patronising. Never generic. Never use "user" — say "you".',
    'Use Indian context where natural (Bangalore PM, Mumbai consulting, IIT/NIT, GATE/CAT) but do not force it.',
    'Output STRICT JSON matching the provided schema. No prose outside JSON. No markdown.',
  ].join(' ');
}

function buildUserPrompt(input, summary) {
  const lines = [];
  lines.push(`Objective: ${input.objectiveType} — ${input.specificsCanonical || 'general'}`);
  if (input.companyProfile && input.companyProfile.name) {
    lines.push(`Target company: ${input.companyProfile.name} (${input.companyProfile.industry || 'unknown'})`);
  }
  lines.push(`Timeline: ${input.timelineWeeks} weeks at ${input.weeklyCommitHours} hrs/week`);
  lines.push('');
  lines.push(`Calibration summary: ${summary.wellCalibratedCount} of ${summary.totalTopics} topics well-calibrated. Dominant pattern: ${summary.dominantPattern}.`);
  lines.push('');
  lines.push('Per-topic results:');
  for (const t of summary.classifiedTopics) {
    const orig = input.topics.find(x => x.canonicalName === t.canonicalName) || {};
    lines.push(
      `- ${orig.name || t.canonicalName} (${t.canonicalName}): self-rated ${orig.selfRating}, measured ${t.measuredScore}/100 (${t.measuredBand}), delta ${t.calibrationDelta >= 0 ? '+' : ''}${t.calibrationDelta} (${t.calibrationClass}). Missed difficulties: ${(orig.missedDifficulties || []).join(', ') || 'none'}.`,
    );
  }
  lines.push('');
  lines.push('Write:');
  lines.push('1. hero — ONE sentence positioning the user. Reference their strongest signal or biggest gap. Keep it punchy.');
  lines.push('2. calibration — ONE sentence summarising the calibration story (e.g., "well-calibrated on 5 of 7 topics" + named blind spot).');
  lines.push('3. patterns — 2 cross-cutting observations (not topic-specific). Each one sentence.');
  lines.push('4. topicTakeaways — exactly one short line per topic by canonicalName. Concrete next move.');
  lines.push('5. planHeadline — 3-4 sentences explaining what the plan will do across the timeline. Reference hours/week and the biggest gap.');
  return lines.join('\n');
}

async function callLLMWithTimeout(messages, { timeoutMs }) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('LLM_TIMEOUT')), timeoutMs);
  });
  const llmPromise = openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.4,
    response_format: { type: 'json_schema', json_schema: INSIGHTS_JSON_SCHEMA },
  });
  try {
    const result = await Promise.race([llmPromise, timeoutPromise]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function validateInsightsShape(obj, expectedTopicNames) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.hero !== 'string' || obj.hero.length < 5) return false;
  if (typeof obj.calibration !== 'string' || obj.calibration.length < 5) return false;
  if (!Array.isArray(obj.patterns) || obj.patterns.length < 1) return false;
  if (!obj.topicTakeaways || typeof obj.topicTakeaways !== 'object') return false;
  for (const name of expectedTopicNames) {
    if (typeof obj.topicTakeaways[name] !== 'string') return false;
  }
  if (typeof obj.planHeadline !== 'string' || obj.planHeadline.length < 20) return false;
  return true;
}

function _templateInsights(input) {
  const summary = calibration.summarizeAttempt(input.topics);
  const striking = summary.mostStrikingTopic;
  const strikingOrig = striking ? input.topics.find(x => x.canonicalName === striking.canonicalName) : null;
  const strikingName = strikingOrig?.name || striking?.canonicalName || 'a key topic';

  let hero;
  if (!striking) {
    hero = 'Your diagnostic is in — let\'s build a plan around what you actually need.';
  } else if (striking.calibrationClass === 'overestimates') {
    hero = `You rated yourself strong on ${strikingName}, but the answers say it\'s your biggest growth area.`;
  } else if (striking.calibrationClass === 'undersells') {
    hero = `You\'re stronger on ${strikingName} than you gave yourself credit for — own it.`;
  } else {
    hero = `You\'re well-calibrated on ${strikingName} — a solid base to build from.`;
  }

  const calibrationLine = summary.dominantPattern === 'overestimates'
    ? `Well-calibrated on ${summary.wellCalibratedCount} of ${summary.totalTopics} topics — you tend to overrate skills you use daily.`
    : summary.dominantPattern === 'undersells'
      ? `Well-calibrated on ${summary.wellCalibratedCount} of ${summary.totalTopics} topics — you consistently underrate yourself.`
      : summary.dominantPattern === 'well-calibrated'
        ? `Well-calibrated on ${summary.wellCalibratedCount} of ${summary.totalTopics} topics — your self-awareness is sharp.`
        : `Well-calibrated on ${summary.wellCalibratedCount} of ${summary.totalTopics} topics — a mixed picture worth unpacking.`;

  const patterns = [];
  if (summary.overestimatesCount >= 2) patterns.push('You overrate the skills you use most often — familiarity ≠ mastery.');
  if (summary.undersellsCount >= 2) patterns.push('You underrate yourself in places you actually deliver — confidence is a skill too.');
  const missedHard = input.topics.filter(t => (t.missedDifficulties || []).includes('hard')).length;
  if (missedHard >= 2) patterns.push('Hard-difficulty questions are where you stumble most — fixable with deliberate practice.');
  if (patterns.length === 0) patterns.push('Your performance is consistent across topics — a steady foundation to optimise from.');

  const topicTakeaways = {};
  for (const t of summary.classifiedTopics) {
    const orig = input.topics.find(x => x.canonicalName === t.canonicalName) || {};
    const name = orig.name || t.canonicalName;
    if (t.calibrationClass === 'overestimates') {
      topicTakeaways[t.canonicalName] = `Bigger gap than you thought on ${name} — early focus pays off.`;
    } else if (t.calibrationClass === 'undersells') {
      topicTakeaways[t.canonicalName] = `Stronger than you rated on ${name} — push for harder challenges.`;
    } else if (t.measuredBand === 'Expert' || t.measuredBand === 'Proficient') {
      topicTakeaways[t.canonicalName] = `Solid on ${name} — keep sharp with periodic reviews.`;
    } else {
      topicTakeaways[t.canonicalName] = `On track on ${name} — steady reps will compound.`;
    }
  }

  const focus = striking && striking.calibrationClass === 'overestimates' ? strikingName : 'your biggest gaps';
  const planHeadline = `Over ${input.timelineWeeks} weeks at ${input.weeklyCommitHours} hrs/week, your plan will front-load ${focus}, reinforce strengths with weekly reps, and check in at ${Math.max(2, Math.floor(input.timelineWeeks / 4))} milestones. We\'ve left buffer for life. The first three weeks will move the needle most.`;

  return { hero, calibration: calibrationLine, patterns, topicTakeaways, planHeadline };
}

async function generateInsights(input, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const summary = calibration.summarizeAttempt(input.topics);
  const expectedTopicNames = input.topics.map(t => t.canonicalName);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user',   content: buildUserPrompt(input, summary) },
  ];

  let raw;
  try {
    raw = await callLLMWithTimeout(messages, { timeoutMs });
  } catch (err) {
    const reason = err && err.message === 'LLM_TIMEOUT' ? 'timeout' : 'error';
    return { source: 'template', fallbackReason: reason, insights: _templateInsights(input) };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.choices[0].message.content);
  } catch (_err) {
    return { source: 'template', fallbackReason: 'parse_error', insights: _templateInsights(input) };
  }

  if (!validateInsightsShape(parsed, expectedTopicNames)) {
    return { source: 'template', fallbackReason: 'schema_error', insights: _templateInsights(input) };
  }

  return { source: 'llm', insights: parsed };
}

module.exports = {
  generateInsights,
  _templateInsights,
  _validateInsightsShape: validateInsightsShape,
  DEFAULT_TIMEOUT_MS,
  MODEL,
};
