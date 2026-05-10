const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

delete require.cache[require.resolve('../../models/KnowledgeProfile')];
const KnowledgeProfile = require('../../models/KnowledgeProfile');
delete require.cache[require.resolve('../../models/Plan')];
const Plan = require('../../models/Plan');
delete require.cache[require.resolve('../../models/ContentProgress')];
const ContentProgress = require('../../models/ContentProgress');
delete require.cache[require.resolve('../../models/ExternalContentTouch')];
const ExternalContentTouch = require('../../models/ExternalContentTouch');
delete require.cache[require.resolve('../../models/InterviewSession')];
const InterviewSession = require('../../models/InterviewSession');
delete require.cache[require.resolve('./topicMasteryService')];
const svc = require('./topicMasteryService');

function chainLean(value) {
  return { lean: async () => value };
}
function chainPopulateLean(value) {
  return { populate: () => ({ lean: async () => value }) };
}
function chainSelectLean(value) {
  return { select: () => ({ lean: async () => value }) };
}
function chainSortLimitLean(value) {
  return { sort: () => ({ limit: () => ({ lean: async () => value }) }) };
}

test('getMasterySummary: aggregates topics + interview rollup', async () => {
  const userId = new mongoose.Types.ObjectId();

  const origKpFind = KnowledgeProfile.findOne;
  KnowledgeProfile.findOne = () => chainLean({
    userId,
    topicMastery: [
      { topic: 'product-strategy', score: 64, level: 'intermediate', quizzesTaken: 3, lastAssessedAt: new Date(), scoreHistory: [{ score: 50, date: new Date() }, { score: 64, date: new Date() }], trend: 'improving' },
      { topic: 'roadmapping', score: 38, level: 'beginner', quizzesTaken: 1, scoreHistory: [], trend: 'stable' },
    ],
    topicInterviewMastery: { 'product-strategy': { score: 7.5, sessions: 2, trend: 'improving' } },
  });

  const origPlanFind = Plan.findOne;
  Plan.findOne = () => chainLean({
    weeklySchedule: [{ tasks: [
      { topic: { canonicalName: 'product-strategy', displayName: 'Product Strategy' } },
      { topic: { canonicalName: 'roadmapping', displayName: 'Roadmapping' } },
    ] }],
  });

  const origCpFind = ContentProgress.find;
  ContentProgress.find = () => chainPopulateLean([
    { contentId: { topics: ['product-strategy'] } },
    { contentId: { topics: ['product-strategy', 'roadmapping'] } },
  ]);

  const origEctFind = ExternalContentTouch.find;
  ExternalContentTouch.find = () => chainSelectLean([
    { topicCanonicalName: 'product-strategy' },
  ]);

  const origIsFind = InterviewSession.find;
  InterviewSession.find = () => chainSortLimitLean([
    { evaluation: { overallScore: 65 } },
    { evaluation: { overallScore: 60 } },
    { evaluation: { overallScore: 55 } },
  ]);

  try {
    const out = await svc.getMasterySummary(userId);
    assert.strictEqual(out.topics.length, 2);
    const ps = out.topics.find(t => t.canonicalName === 'product-strategy');
    assert.strictEqual(ps.displayName, 'Product Strategy');
    assert.strictEqual(ps.contentConsumed, 2);
    assert.strictEqual(ps.externalTouches, 1);
    const rd = out.topics.find(t => t.canonicalName === 'roadmapping');
    assert.strictEqual(rd.contentConsumed, 1);
    assert.strictEqual(rd.externalTouches, 0);
    assert.strictEqual(out.interview.totalSessions, 3);
    assert.strictEqual(out.interview.averageScore, 60);
    assert.strictEqual(out.interview.perTopic.length, 1);
    assert.strictEqual(out.interview.perTopic[0].topic, 'product-strategy');
  } finally {
    KnowledgeProfile.findOne = origKpFind;
    Plan.findOne = origPlanFind;
    ContentProgress.find = origCpFind;
    ExternalContentTouch.find = origEctFind;
    InterviewSession.find = origIsFind;
  }
});

test('getMasterySummary: returns empty rollup when user has no profile', async () => {
  const userId = new mongoose.Types.ObjectId();
  const origKpFind = KnowledgeProfile.findOne;
  KnowledgeProfile.findOne = () => chainLean(null);
  const origPlanFind = Plan.findOne;
  Plan.findOne = () => chainLean(null);
  const origIsFind = InterviewSession.find;
  InterviewSession.find = () => chainSortLimitLean([]);

  try {
    const out = await svc.getMasterySummary(userId);
    assert.deepStrictEqual(out.topics, []);
    assert.strictEqual(out.interview.totalSessions, 0);
    assert.strictEqual(out.interview.averageScore, 0);
    assert.strictEqual(out.interview.perTopic.length, 0);
  } finally {
    KnowledgeProfile.findOne = origKpFind;
    Plan.findOne = origPlanFind;
    InterviewSession.find = origIsFind;
  }
});
