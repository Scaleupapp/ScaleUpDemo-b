const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// Stub streakService BEFORE requiring dashboardService so its in-module
// reference is the no-op stub.
const streakPath = require.resolve('./streakService');
require.cache[streakPath] = {
  exports: { ensureStreakFresh: async () => {} },
  loaded: true,
  id: streakPath,
};

// Stub journeyProgressService.syncProgress (also referenced by dashboardService).
const jpsPath = require.resolve('./journeyProgressService');
require.cache[jpsPath] = {
  exports: { syncProgress: async () => {} },
  loaded: true,
  id: jpsPath,
};

const UserObjective = require('../models/UserObjective');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const Journey = require('../models/Journey');
const Quiz = require('../models/Quiz');
const ContentProgress = require('../models/ContentProgress');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const Plan = require('../models/Plan');

// Fresh-require AFTER cache stubs are in place.
delete require.cache[require.resolve('./dashboardService')];
const dashboardService = require('./dashboardService');

/**
 * Helper: stub all collaborators dashboardService.getDashboard touches to
 * harmless defaults so each test can override only what it cares about.
 */
function installBaseStubs() {
  const orig = {
    UserObjective_find: UserObjective.find,
    KnowledgeProfile_findOne: KnowledgeProfile.findOne,
    Journey_findOne: Journey.findOne,
    Quiz_countDocuments: Quiz.countDocuments,
    ContentProgress_countDocuments: ContentProgress.countDocuments,
    ConsumptionGraph_findOne: ConsumptionGraph.findOne,
    Plan_findOne: Plan.findOne,
  };

  UserObjective.find = () => ({ sort: async () => [] });
  KnowledgeProfile.findOne = async () => null;
  Journey.findOne = () => ({ sort: async () => null });
  Quiz.countDocuments = async () => 0;
  ContentProgress.countDocuments = async () => 0;
  ConsumptionGraph.findOne = async () => null;
  // Plan default: no active plan
  Plan.findOne = () => ({ select: () => ({ lean: async () => null }) });

  return () => {
    UserObjective.find = orig.UserObjective_find;
    KnowledgeProfile.findOne = orig.KnowledgeProfile_findOne;
    Journey.findOne = orig.Journey_findOne;
    Quiz.countDocuments = orig.Quiz_countDocuments;
    ContentProgress.countDocuments = orig.ContentProgress_countDocuments;
    ConsumptionGraph.findOne = orig.ConsumptionGraph_findOne;
    Plan.findOne = orig.Plan_findOne;
  };
}

test('getDashboard: includes planProgress when user has active plan', async () => {
  const restore = installBaseStubs();
  Plan.findOne = () => ({
    select: () => ({
      lean: async () => ({
        weeklySchedule: [
          { tasks: [
            { progress: { status: 'complete' } },
            { progress: { status: 'in_progress' } },
            { progress: { status: 'not_started' } },
          ] },
          { tasks: [
            { progress: { status: 'complete' } },
            { progress: { status: 'not_started' } },
          ] },
        ],
      }),
    }),
  });

  try {
    const out = await dashboardService.getDashboard(new mongoose.Types.ObjectId());
    assert.ok(out.planProgress, 'planProgress should be present');
    assert.strictEqual(out.planProgress.tasksTotal, 5);
    assert.strictEqual(out.planProgress.tasksComplete, 2);
    assert.ok(Math.abs(out.planProgress.fraction - 0.4) < 1e-9, 'fraction should be 0.4');
  } finally {
    restore();
  }
});

test('getDashboard: planProgress is null when user has no active plan', async () => {
  const restore = installBaseStubs();
  // Plan.findOne default already returns null.
  try {
    const out = await dashboardService.getDashboard(new mongoose.Types.ObjectId());
    assert.strictEqual(out.planProgress, null);
  } finally {
    restore();
  }
});

test('getDashboard: planProgress fraction is 0 when active plan has zero tasks', async () => {
  const restore = installBaseStubs();
  Plan.findOne = () => ({
    select: () => ({
      lean: async () => ({ weeklySchedule: [{ tasks: [] }] }),
    }),
  });
  try {
    const out = await dashboardService.getDashboard(new mongoose.Types.ObjectId());
    assert.ok(out.planProgress, 'planProgress should be present');
    assert.strictEqual(out.planProgress.tasksTotal, 0);
    assert.strictEqual(out.planProgress.tasksComplete, 0);
    assert.strictEqual(out.planProgress.fraction, 0);
  } finally {
    restore();
  }
});
