'use strict';

const assert = require('assert');
const mongoose = require('mongoose');

// Stub queue before loading service
const queuePath = require.resolve('../../config/queue');
require.cache[queuePath] = {
  exports: { planGenerationQueue: { add: async (...args) => { lastQueued = args; } } },
  loaded: true, id: queuePath,
};

let lastQueued = null;

// ---------------------------------------------------------------------------
// Build minimal attempt-like objects for computeGrowth
// ---------------------------------------------------------------------------

function makeResults(entries) {
  return new Map(entries.map(([name, score]) => [name, { score, assessedBand: 'familiar', questionsAsked: 2 }]));
}

function makeAttempt(resultsEntries, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    status: 'completed',
    attemptType: 'recalibration',
    results: makeResults(resultsEntries),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test_perTopicGrowthBarsAndBiggestJump() {
  const { computeGrowth } = require('./recalibrationResultsService');

  const prev = makeAttempt([['pm-metrics', 50], ['sql-basics', 40], ['excel', 70]]);
  const recal = makeAttempt([['pm-metrics', 70], ['sql-basics', 45], ['excel', 65]], {
    previousAttemptId: prev._id,
  });

  const growth = computeGrowth(recal, prev);

  assert.ok(Array.isArray(growth.growthBars), 'growthBars should be an array');
  assert.strictEqual(growth.growthBars.length, 3);

  const pmBar = growth.growthBars.find(b => b.canonicalName === 'pm-metrics');
  assert.ok(pmBar, 'pm-metrics bar must exist');
  assert.strictEqual(pmBar.oldScore, 50);
  assert.strictEqual(pmBar.newScore, 70);
  assert.strictEqual(pmBar.delta, 20);
  assert.strictEqual(pmBar.bandShift, 'improved');

  // biggestJump should be pm-metrics (delta=20 is largest)
  assert.ok(growth.biggestJump, 'biggestJump must be set');
  assert.strictEqual(growth.biggestJump.canonicalName, 'pm-metrics');
  assert.strictEqual(growth.biggestJump.delta, 20);

  assert.ok(typeof growth.summary === 'string', 'summary should be a string');
}

async function test_newGapsDetectedWhenDropGte20() {
  const { computeGrowth, NEW_GAP_DROP_THRESHOLD } = require('./recalibrationResultsService');

  assert.strictEqual(NEW_GAP_DROP_THRESHOLD, 20, 'threshold constant should be 20');

  const prev = makeAttempt([['pm-metrics', 80], ['sql-basics', 60]]);
  const recal = makeAttempt([['pm-metrics', 55], ['sql-basics', 62]], {
    previousAttemptId: prev._id,
  });

  const growth = computeGrowth(recal, prev);

  // pm-metrics dropped 25pts (>= 20) → new gap
  assert.ok(growth.newGaps.includes('pm-metrics'), 'pm-metrics should be a new gap (drop=25)');
  // sql-basics improved slightly → NOT a gap
  assert.ok(!growth.newGaps.includes('sql-basics'), 'sql-basics should NOT be a new gap');
}

async function test_rebalancePlan_callsPlanWorker() {
  const { rebalancePlan } = require('./recalibrationResultsService');
  lastQueued = null;

  const attemptId = new mongoose.Types.ObjectId();
  await rebalancePlan(String(attemptId));

  assert.ok(lastQueued, 'planGenerationQueue.add should have been called');
  assert.strictEqual(lastQueued[0], 'generate');
  assert.strictEqual(lastQueued[1].attemptId, String(attemptId));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  const tests = [
    test_perTopicGrowthBarsAndBiggestJump,
    test_newGapsDetectedWhenDropGte20,
    test_rebalancePlan_callsPlanWorker,
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
