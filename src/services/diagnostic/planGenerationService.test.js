const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const openaiPath = require.resolve('../../config/openai');
const fakeOpenAI = {
  chat: { completions: { create: async () => ({}) } },
};
require.cache[openaiPath] = { exports: fakeOpenAI };

delete require.cache[require.resolve('./planGenerationService')];
const svc = require('./planGenerationService');

const baseInput = () => ({
  userId: new mongoose.Types.ObjectId(),
  objectiveId: new mongoose.Types.ObjectId(),
  diagnosticAttemptId: new mongoose.Types.ObjectId(),
  objectiveType: 'interview_preparation',
  specificsCanonical: { targetRole: 'Product Manager', targetCompany: 'Razorpay' },
  companyProfile: null,
  timeline: 8,
  weeklyCommitHours: 6,
  topicResults: [
    { canonicalName: 'product-strategy', selfRating: 'familiar', measuredScore: 35, measuredBand: 'familiar', calibrationDelta: -7, calibrationClass: 'well-calibrated', questionsAsked: 3, answerPattern: { easy: 1, medium: 1, hard: 0 }, isFutureProofing: false },
    { canonicalName: 'stakeholder-mgmt', selfRating: 'proficient', measuredScore: 30, measuredBand: 'novice', calibrationDelta: -37, calibrationClass: 'overestimates', questionsAsked: 3, answerPattern: { easy: 1, medium: 0, hard: 0 }, isFutureProofing: false },
    { canonicalName: 'ai-product-strategy', selfRating: 'novice', measuredScore: 20, measuredBand: 'novice', calibrationDelta: 5, calibrationClass: 'well-calibrated', questionsAsked: 2, answerPattern: { easy: 0, medium: 0, hard: 0 }, isFutureProofing: true },
  ],
  userMilestoneHints: [],
});

test('planGenerationService.generate: builds plan from LLM JSON', async () => {
  fakeOpenAI.chat.completions.create = async () => ({
    choices: [{ message: { content: JSON.stringify({
      planHeadline: 'Eight weeks to interview-ready PM at Razorpay.',
      bufferRecommendation: "We've left 15% buffer for life events.",
      weeklySchedule: [
        { week: 1, weeklyGoal: 'Foundations', allocations: [
          { topicCanonicalName: 'stakeholder-mgmt', hours: 3, focusActivity: 'Foundations module' },
          { topicCanonicalName: 'product-strategy', hours: 2, focusActivity: 'Read + reflect' },
          { topicCanonicalName: 'ai-product-strategy', hours: 1, focusActivity: 'Build with LLMs primer' },
        ]},
        { week: 2, weeklyGoal: 'Apply', allocations: [
          { topicCanonicalName: 'stakeholder-mgmt', hours: 3, focusActivity: 'Practice' },
          { topicCanonicalName: 'product-strategy', hours: 2, focusActivity: 'Cases' },
          { topicCanonicalName: 'ai-product-strategy', hours: 1, focusActivity: 'Tools' },
        ]},
      ],
      milestones: [
        { week: 4, title: 'Mock behavioral', measurableCriteria: 'Score 4/5 STAR clarity', isUserStated: false },
      ],
    })}}],
    usage: { total_tokens: 1500 },
  });
  const out = await svc.generate(baseInput());
  assert.strictEqual(out.source, 'llm-generated');
  assert.strictEqual(out.weeklySchedule.length, 2);
  assert.strictEqual(out.milestones[0].title, 'Mock behavioral');
  assert.ok(out.planHeadline.includes('Razorpay'));
  assert.ok(out.estimatedTotalHours > 0);
});

test('planGenerationService.generate: falls back to template on LLM error', async () => {
  fakeOpenAI.chat.completions.create = async () => { throw new Error('ETIMEDOUT'); };
  const out = await svc.generate(baseInput());
  assert.strictEqual(out.source, 'template');
  assert.ok(out.weeklySchedule.length === 8, 'template uses full timeline weeks');
  assert.ok(out.planHeadline.length > 0);
});

test('planGenerationService.generate: caps total hours at 0.85 of capacity', async () => {
  fakeOpenAI.chat.completions.create = async () => ({
    choices: [{ message: { content: JSON.stringify({
      planHeadline: 'X',
      bufferRecommendation: 'Y',
      weeklySchedule: Array.from({ length: 8 }, (_, i) => ({
        week: i + 1,
        weeklyGoal: 'g',
        allocations: [
          { topicCanonicalName: 'product-strategy', hours: 8, focusActivity: 'a' },
          { topicCanonicalName: 'stakeholder-mgmt', hours: 8, focusActivity: 'a' },
        ],
      })),
      milestones: [],
    })}}],
  });
  const input = baseInput();
  const cap = input.timeline * input.weeklyCommitHours * 0.85;
  const out = await svc.generate(input);
  assert.ok(out.estimatedTotalHours <= cap + 0.5, `total ${out.estimatedTotalHours} > cap ${cap}`);
});

test('planGenerationService.generate: applies +20% to overestimates topics in template', async () => {
  fakeOpenAI.chat.completions.create = async () => { throw new Error('fail'); };
  const out = await svc.generate(baseInput());
  const totalsByTopic = {};
  out.weeklySchedule.forEach(w => w.allocations.forEach(a => {
    totalsByTopic[a.topicCanonicalName] = (totalsByTopic[a.topicCanonicalName] || 0) + a.hours;
  }));
  assert.ok(totalsByTopic['stakeholder-mgmt'] > totalsByTopic['product-strategy'],
    'overestimates topic should receive more hours');
});

test('planGenerationService.generate: future-proofing topics get >=8% of total', async () => {
  fakeOpenAI.chat.completions.create = async () => { throw new Error('fail'); };
  const out = await svc.generate(baseInput());
  const totalsByTopic = {};
  out.weeklySchedule.forEach(w => w.allocations.forEach(a => {
    totalsByTopic[a.topicCanonicalName] = (totalsByTopic[a.topicCanonicalName] || 0) + a.hours;
  }));
  const aiShare = (totalsByTopic['ai-product-strategy'] || 0) / out.estimatedTotalHours;
  assert.ok(aiShare >= 0.08, `future-proofing share ${aiShare} should be >= 0.08`);
});

test('planGenerationService.buildTemplate: novice topics appear in week 1', async () => {
  fakeOpenAI.chat.completions.create = async () => { throw new Error('fail'); };
  const out = await svc.generate(baseInput());
  const week1Topics = out.weeklySchedule[0].allocations.map(a => a.topicCanonicalName);
  assert.ok(week1Topics.includes('stakeholder-mgmt'), 'novice topic in week 1');
});
