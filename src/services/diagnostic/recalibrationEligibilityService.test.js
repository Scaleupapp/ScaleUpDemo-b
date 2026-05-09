'use strict';

const assert = require('assert');

// ---------------------------------------------------------------------------
// Minimal stub helpers
// ---------------------------------------------------------------------------

function makeAttempt(overrides = {}) {
  const base = {
    _id: 'attempt1',
    status: 'completed',
    completedAt: new Date(Date.now() - 35 * 86400000), // 35 days ago
    results: new Map([
      ['pm-metrics', { score: 60, calibrationDelta: -2 }],
      ['sql-basics',  { score: 45, calibrationDelta:  3 }],
      ['excel',       { score: 70, calibrationDelta: -1 }],
    ]),
  };
  return Object.assign({}, base, overrides);
}

function makePlan(overrides = {}) {
  return Object.assign({ _id: 'plan1', isActive: true }, overrides);
}

function stubModels({ attempt = null, plan = null, hours = {} } = {}) {
  // Stub DiagnosticAttempt
  const DiagnosticAttempt = require('../../models/DiagnosticAttempt');
  const origFindOne = DiagnosticAttempt.findOne.bind(DiagnosticAttempt);
  DiagnosticAttempt.findOne = () => ({
    lean: () => Promise.resolve(attempt),
  });

  // Stub Plan
  const Plan = require('../../models/Plan');
  Plan.findOne = () => ({
    lean: () => Promise.resolve(plan),
  });

  // Stub journeyProgressService via require.cache
  const jpsKey = require.resolve('../journeyProgressService');
  require.cache[jpsKey] = {
    id: jpsKey,
    filename: jpsKey,
    loaded: true,
    exports: {
      getHoursSpentByTopic: async () => hours,
    },
  };

  return () => {
    DiagnosticAttempt.findOne = origFindOne;
    delete require.cache[jpsKey];
    // Force re-require of eligibility service to clear cached journeyProgressService
    const svcKey = require.resolve('./recalibrationEligibilityService');
    delete require.cache[svcKey];
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test_tooRecent_returnsNotEligible() {
  const recentAttempt = makeAttempt({
    completedAt: new Date(Date.now() - 3 * 86400000), // only 3 days ago — under new 7d gate
  });
  const restore = stubModels({ attempt: recentAttempt });
  try {
    delete require.cache[require.resolve('./recalibrationEligibilityService')];
    const svc = require('./recalibrationEligibilityService');
    const result = await svc.computeEligibility('user1', {});
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.reason, 'too_recent');
    assert.ok(result.daysSinceLast < 7, 'should report days since last');
  } finally {
    restore();
  }
}

async function test_passesCooldownAtDay8() {
  // 8 days ago — was blocked under old 30d gate, must pass under new 7d gate.
  // Uses the biggest-gap-always-included rule to pass with no plan/hours.
  const attempt = makeAttempt({
    completedAt: new Date(Date.now() - 8 * 86400000),
  });
  const plan = makePlan();
  const hours = {};
  const restore = stubModels({ attempt, plan, hours });
  try {
    delete require.cache[require.resolve('./recalibrationEligibilityService')];
    const svc = require('./recalibrationEligibilityService');
    const result = await svc.computeEligibility('user1', {});
    assert.strictEqual(result.eligible, true, `expected eligible=true at day 8; got ${JSON.stringify(result)}`);
  } finally {
    restore();
  }
}

async function test_30dPlusAndFiveHours_returnsEligible() {
  const attempt = makeAttempt(); // 35 days ago
  const plan = makePlan();
  // pm-metrics has 6h spent → qualifies on hours; sql-basics has |delta|=3 (biggest gap)
  const hours = { 'pm-metrics': 6, 'sql-basics': 0, 'excel': 1 };
  const restore = stubModels({ attempt, plan, hours });
  try {
    delete require.cache[require.resolve('./recalibrationEligibilityService')];
    const svc = require('./recalibrationEligibilityService');
    const result = await svc.computeEligibility('user1', {});
    assert.strictEqual(result.eligible, true);
    assert.ok(Array.isArray(result.eligibleTopics));
    // sql-basics is biggest gap (|delta|=3), pm-metrics qualifies on hours
    assert.ok(result.eligibleTopics.includes('sql-basics'), 'biggest gap topic must be included');
    assert.ok(result.eligibleTopics.includes('pm-metrics'), 'hours topic must be included');
    assert.ok(typeof result.expectedDurationMin === 'number');
    assert.strictEqual(result.previousAttemptId, 'attempt1');
  } finally {
    restore();
  }
}

async function test_biggestGapAlwaysIncluded() {
  const attempt = makeAttempt(); // sql-basics has |calibrationDelta|=3 — biggest
  const plan = makePlan();
  // No hours spent on anything
  const hours = {};
  const restore = stubModels({ attempt, plan, hours });
  try {
    delete require.cache[require.resolve('./recalibrationEligibilityService')];
    const svc = require('./recalibrationEligibilityService');
    const result = await svc.computeEligibility('user1', {});
    assert.strictEqual(result.eligible, true);
    assert.ok(result.eligibleTopics.includes('sql-basics'), 'biggest gap (sql-basics, delta=3) must always be included');
  } finally {
    restore();
  }
}

async function test_userFlagOverride() {
  const attempt = makeAttempt(); // 35 days ago
  const plan = makePlan();
  const hours = {};
  const restore = stubModels({ attempt, plan, hours });
  try {
    delete require.cache[require.resolve('./recalibrationEligibilityService')];
    const svc = require('./recalibrationEligibilityService');
    const result = await svc.computeEligibility('user1', { userFlaggedTopics: ['excel'] });
    assert.strictEqual(result.eligible, true);
    assert.ok(result.eligibleTopics.includes('excel'), 'user-flagged topic must be included');
  } finally {
    restore();
  }
}

async function test_capsAtSix() {
  // Build attempt with 8 topics — after biggest gap + a couple hours, must cap at 6
  const results = new Map();
  for (let i = 0; i < 8; i++) {
    results.set(`topic-${i}`, { score: 50, calibrationDelta: i === 7 ? 5 : 0 });
  }
  const attempt = makeAttempt({ results });
  const plan = makePlan();
  // All topics have ≥5h
  const hours = {};
  for (let i = 0; i < 8; i++) hours[`topic-${i}`] = 6;
  const restore = stubModels({ attempt, plan, hours });
  try {
    delete require.cache[require.resolve('./recalibrationEligibilityService')];
    const svc = require('./recalibrationEligibilityService');
    const result = await svc.computeEligibility('user1', {});
    assert.strictEqual(result.eligible, true);
    assert.ok(result.eligibleTopics.length <= 6, `expected ≤6 topics, got ${result.eligibleTopics.length}`);
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  const tests = [
    test_tooRecent_returnsNotEligible,
    test_passesCooldownAtDay8,
    test_30dPlusAndFiveHours_returnsEligible,
    test_biggestGapAlwaysIncluded,
    test_userFlagOverride,
    test_capsAtSix,
  ];

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${t.name}: ${err.message}`);
      failed++;
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
})();
