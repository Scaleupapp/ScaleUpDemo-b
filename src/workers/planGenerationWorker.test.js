const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// Mock dependencies
const planGenPath = require.resolve('../services/diagnostic/planGenerationService');
const notifyPath = require.resolve('../services/diagnostic/planReadyNotificationService');
const planModelPath = require.resolve('../models/Plan');
const attemptModelPath = require.resolve('../models/DiagnosticAttempt');
const objectiveModelPath = require.resolve('../models/UserObjective');
const companyModelPath = require.resolve('../models/CompanyProfile');

const planGenCalls = [];
require.cache[planGenPath] = {
  exports: {
    generate: async (input) => {
      planGenCalls.push(input);
      return {
        planHeadline: 'Test plan',
        bufferRecommendation: 'b',
        weeklySchedule: [{ week: 1, weeklyGoal: 'g', allocations: [{ topicCanonicalName: 'x', hours: 1, focusActivity: 'a' }] }],
        milestones: [],
        estimatedTotalHours: 1,
        source: 'llm-generated',
        llmLatencyMs: 1234,
        llmModel: 'gpt-4o',
      };
    },
  },
};

const notifyCalls = [];
require.cache[notifyPath] = {
  exports: { notify: async (userId, planId) => { notifyCalls.push({ userId: String(userId), planId: String(planId) }); return { success: true }; } },
};

// Stub Plan, DiagnosticAttempt, UserObjective, CompanyProfile models
let savedPlans = [];
let supersededIds = [];
require.cache[planModelPath] = {
  exports: Object.assign(
    function PlanCtor(data) { Object.assign(this, data); this._id = new mongoose.Types.ObjectId(); this.save = async () => { savedPlans.push(this); return this; }; },
    {
      updateMany: async (filter, update) => { supersededIds.push({ filter, update }); return { modifiedCount: 1 }; },
    }
  ),
};

let attemptDoc;
require.cache[attemptModelPath] = {
  exports: {
    findById: () => ({
      select: () => ({
        lean: async () => attemptDoc,
      }),
    }),
    updateOne: async (filter, update) => { Object.assign(attemptDoc, update.$set || {}); return { modifiedCount: 1 }; },
  },
};

let objectiveDoc;
require.cache[objectiveModelPath] = {
  exports: { findById: () => ({ lean: async () => objectiveDoc }) },
};

require.cache[companyModelPath] = {
  exports: { findOne: () => ({ lean: async () => null }) },
};

delete require.cache[require.resolve('./planGenerationWorker')];
const worker = require('./planGenerationWorker');

test('planGenerationWorker: full happy path persists Plan, marks attempt ready, notifies user', async () => {
  savedPlans = []; planGenCalls.length = 0; notifyCalls.length = 0; supersededIds = [];
  const userId = new mongoose.Types.ObjectId();
  const objectiveId = new mongoose.Types.ObjectId();
  const attemptId = new mongoose.Types.ObjectId();
  attemptDoc = {
    _id: attemptId,
    userId,
    objectiveSnapshot: { _id: objectiveId },
    results: new Map([
      ['product-strategy', { assessedBand: 'familiar', score: 40, calibrationDelta: -5, questionsAsked: 3 }],
    ]),
    selfRatings: new Map([['product-strategy', 'familiar']]),
    planGenerationStatus: 'generating',
  };
  objectiveDoc = {
    _id: objectiveId,
    userId,
    objectiveType: 'upskilling',
    specifics: { targetSkill: 'PM' },
    specificsCanonical: { targetSkill: 'product-management' },
    timeline: 8,
    weeklyCommitHours: 6,
    topicsOfInterest: ['product-strategy'],
  };

  await worker.processJob({ data: { attemptId: String(attemptId) } });

  assert.strictEqual(planGenCalls.length, 1, 'plan service called once');
  assert.strictEqual(savedPlans.length, 1, 'one Plan saved');
  assert.strictEqual(savedPlans[0].source, 'llm-generated');
  assert.strictEqual(attemptDoc.planGenerationStatus, 'ready');
  assert.ok(attemptDoc.planId, 'attempt linked to plan');
  assert.strictEqual(notifyCalls.length, 1);
  assert.strictEqual(notifyCalls[0].userId, String(userId));
});

test('planGenerationWorker: marks attempt failed if generator throws', async () => {
  savedPlans = []; notifyCalls.length = 0;
  require.cache[planGenPath].exports.generate = async () => { throw new Error('LLM dead'); };
  attemptDoc = {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    objectiveSnapshot: { _id: new mongoose.Types.ObjectId() },
    results: new Map(),
    selfRatings: new Map(),
    planGenerationStatus: 'generating',
  };
  objectiveDoc = {
    _id: attemptDoc.objectiveSnapshot._id,
    objectiveType: 'upskilling',
    timeline: 4,
    weeklyCommitHours: 4,
    topicsOfInterest: [],
  };

  await worker.processJob({ data: { attemptId: String(attemptDoc._id) } });

  assert.strictEqual(attemptDoc.planGenerationStatus, 'failed');
  assert.strictEqual(savedPlans.length, 0, 'no plan persisted on failure');
  assert.strictEqual(notifyCalls.length, 0, 'no notification on failure');
});
