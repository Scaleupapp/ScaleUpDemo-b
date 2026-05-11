const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const Plan = require('../models/Plan');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const UserObjective = require('../models/UserObjective');

const recommendationService = require('./recommendationService');

/**
 * Helper: build a lean-style chained query stub.
 * Mongoose's `.select(...).lean()` returns a thenable resolving to `value`.
 */
function leanChain(value) {
  return () => ({ select: () => ({ lean: async () => value }) });
}

/**
 * Helper: stub UserObjective.find which uses `.select(...).lean()` for arrays.
 */
function leanFindChain(value) {
  return () => ({ select: () => ({ lean: async () => value }) });
}

test('_gatherUserTopics: combines UserObjective.topicSelfRatings + Plan allocations + ConsumptionGraph + topicsOfInterest', async () => {
  const userId = new mongoose.Types.ObjectId();

  const origPlan = Plan.findOne;
  const origGraph = ConsumptionGraph.findOne;
  const origObj = UserObjective.find;

  Plan.findOne = leanChain({
    weeklySchedule: [
      { allocations: [{ topicCanonicalName: 'topic-b' }, { topicCanonicalName: 'topic-shared' }] },
    ],
  });
  ConsumptionGraph.findOne = leanChain({
    topicNodes: [{ topic: 'topic-c' }],
  });
  UserObjective.find = leanFindChain([
    {
      topicSelfRatings: { 'topic-a': 'familiar', 'topic-shared': 'novice' },
      topicsOfInterest: ['topic-d'],
    },
  ]);

  try {
    const topics = await recommendationService._gatherUserTopics(userId);
    assert.ok(topics.has('topic-a'), 'topicSelfRatings key missing');
    assert.ok(topics.has('topic-b'), 'plan allocation topic missing');
    assert.ok(topics.has('topic-c'), 'consumption graph topic missing');
    assert.ok(topics.has('topic-d'), 'topicsOfInterest entry missing');
    assert.ok(topics.has('topic-shared'), 'shared topic missing');
    // 5 distinct topics, no duplicates
    assert.strictEqual(topics.size, 5);
  } finally {
    Plan.findOne = origPlan;
    ConsumptionGraph.findOne = origGraph;
    UserObjective.find = origObj;
  }
});

test('_gatherUserTopics: returns empty Set when all sources are empty', async () => {
  const userId = new mongoose.Types.ObjectId();

  const origPlan = Plan.findOne;
  const origGraph = ConsumptionGraph.findOne;
  const origObj = UserObjective.find;

  Plan.findOne = leanChain(null);
  ConsumptionGraph.findOne = leanChain(null);
  UserObjective.find = leanFindChain([]);

  try {
    const topics = await recommendationService._gatherUserTopics(userId);
    assert.ok(topics instanceof Set);
    assert.strictEqual(topics.size, 0);
  } finally {
    Plan.findOne = origPlan;
    ConsumptionGraph.findOne = origGraph;
    UserObjective.find = origObj;
  }
});

test('_gatherUserTopics: handles Mongoose Map (live, non-lean) for topicSelfRatings', async () => {
  const userId = new mongoose.Types.ObjectId();

  const origPlan = Plan.findOne;
  const origGraph = ConsumptionGraph.findOne;
  const origObj = UserObjective.find;

  Plan.findOne = leanChain(null);
  ConsumptionGraph.findOne = leanChain(null);
  // Simulate non-lean Map result for topicSelfRatings.
  UserObjective.find = leanFindChain([
    {
      topicSelfRatings: new Map([['map-topic-1', 'novice'], ['map-topic-2', 'expert']]),
      topicsOfInterest: [],
    },
  ]);

  try {
    const topics = await recommendationService._gatherUserTopics(userId);
    assert.ok(topics.has('map-topic-1'));
    assert.ok(topics.has('map-topic-2'));
    assert.strictEqual(topics.size, 2);
  } finally {
    Plan.findOne = origPlan;
    ConsumptionGraph.findOne = origGraph;
    UserObjective.find = origObj;
  }
});
