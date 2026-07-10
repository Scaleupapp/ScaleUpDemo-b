'use strict';

const assert = require('assert');
const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Pre-stub heavy dependencies so diagnosticService loads cleanly (no Redis / OpenAI)
// ---------------------------------------------------------------------------

const queuePath = require.resolve('../config/queue');
require.cache[queuePath] = {
  exports: { planGenerationQueue: { add: async () => ({}) } },
  loaded: true, id: queuePath,
};

const poolPath = require.resolve('./diagnosticPoolService');
require.cache[poolPath] = {
  exports: {
    assemblePool: async () => ({ questions: [] }),
    _internal: { calculatePoolAllocation: () => [] },
  },
  loaded: true, id: poolPath,
};

// ---------------------------------------------------------------------------
// Helper: set up per-test stubs and return a fresh diagnosticService instance
// ---------------------------------------------------------------------------

function setupStubs({ eligibilityResult, previousAttemptDoc = null, objectiveDoc = null } = {}) {
  // Stub eligibility service
  const eligibilityKey = require.resolve('./diagnostic/recalibrationEligibilityService');
  require.cache[eligibilityKey] = {
    id: eligibilityKey, filename: eligibilityKey, loaded: true,
    exports: { computeEligibility: async () => eligibilityResult },
  };

  // Stub DiagnosticAttempt
  const daPath = require.resolve('../models/DiagnosticAttempt');
  let lastCreated = null;
  require.cache[daPath] = {
    exports: {
      findOne: async () => null,
      findById: () => ({ lean: () => Promise.resolve(previousAttemptDoc) }),
      updateMany: async () => ({}),
      create: async (data) => { lastCreated = { _id: new mongoose.Types.ObjectId(), ...data }; return lastCreated; },
    },
    loaded: true, id: daPath,
  };

  // Stub UserObjective
  const uoPath = require.resolve('../models/UserObjective');
  require.cache[uoPath] = {
    exports: {
      findOne: () => ({ lean: () => Promise.resolve(null) }),
      findById: () => ({ lean: () => Promise.resolve(objectiveDoc) }),
    },
    loaded: true, id: uoPath,
  };

  // Stub KnowledgeProfile
  const kpPath = require.resolve('../models/KnowledgeProfile');
  require.cache[kpPath] = {
    exports: { findOne: async () => null },
    loaded: true, id: kpPath,
  };

  // Stub diagnosticSelectorService with selectQuestions
  const selectorPath = require.resolve('./diagnosticSelectorService');
  require.cache[selectorPath] = {
    exports: {
      selectNext: () => ({ shouldStop: true }),
      totalQuestionsForAttempt: () => 4,
      selectQuestions: async () => [{ _id: new mongoose.Types.ObjectId() }, { _id: new mongoose.Types.ObjectId() }],
      _internal: { deriveBand: () => 'familiar', bandToScore: () => 50 },
    },
    loaded: true, id: selectorPath,
  };

  // Force fresh diagnosticService load
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');

  return { svc, getLastCreated: () => lastCreated };
}

function teardown() {
  [
    './diagnostic/recalibrationEligibilityService',
    '../models/DiagnosticAttempt',
    '../models/UserObjective',
    '../models/KnowledgeProfile',
    './diagnosticSelectorService',
    './diagnosticService',
  ].forEach(p => { delete require.cache[require.resolve(p)]; });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test_happyPath_createsAttemptWithRecalibrationType() {
  const userId = new mongoose.Types.ObjectId();
  const prevId = new mongoose.Types.ObjectId();

  const previousAttemptDoc = {
    _id: prevId,
    status: 'completed',
    objectiveSnapshot: { _id: new mongoose.Types.ObjectId() },
    selfRatings: new Map([['pm-metrics', 'familiar']]),
  };

  const objectiveDoc = {
    _id: previousAttemptDoc.objectiveSnapshot._id,
    objectiveType: 'job_switch',
    specifics: { targetRole: 'Product Manager' },
  };

  const { svc, getLastCreated } = setupStubs({
    eligibilityResult: {
      eligible: true,
      eligibleTopics: ['pm-metrics', 'sql-basics'],
      previousAttemptId: String(prevId),
      expectedDurationMin: 2,
    },
    previousAttemptDoc,
    objectiveDoc,
  });

  try {
    const result = await svc.startRecalibration(String(userId), { userFlaggedTopics: [] });

    assert.ok(result.attemptId, 'should return attemptId');
    assert.strictEqual(result.flowType, 'recalibration');
    assert.ok(typeof result.totalEstimatedQuestions === 'number');
    assert.ok(typeof result.estimatedDurationSec === 'number');

    const created = getLastCreated();
    assert.ok(created, 'DiagnosticAttempt.create should have been called');
    assert.strictEqual(created.attemptType, 'recalibration');
    assert.strictEqual(String(created.previousAttemptId), String(prevId));
    assert.strictEqual(created.totalEstimatedQuestions, 2,
      'recalibration must persist totalEstimatedQuestions = pool.length (Workstream C)');
  } finally {
    teardown();
  }
}

async function test_notEligible_throwsWithCode() {
  const userId = new mongoose.Types.ObjectId();

  const { svc } = setupStubs({
    eligibilityResult: { eligible: false, reason: 'too_recent', daysSinceLast: 5 },
  });

  try {
    await svc.startRecalibration(String(userId), {});
    assert.fail('should have thrown NOT_ELIGIBLE error');
  } catch (err) {
    assert.strictEqual(err.code, 'NOT_ELIGIBLE', `expected NOT_ELIGIBLE, got: ${err.code}`);
    assert.ok(err.meta, 'error should carry eligibility meta');
    assert.strictEqual(err.meta.reason, 'too_recent');
  } finally {
    teardown();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  const tests = [
    test_happyPath_createsAttemptWithRecalibrationType,
    test_notEligible_throwsWithCode,
  ];

  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      console.log(`  PASS  ${t.name}`);
    } catch (err) {
      console.error(`  FAIL  ${t.name}: ${err.message}`);
      failed++;
    }
  }

  if (failed > 0) process.exitCode = 1;
})();
