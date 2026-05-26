'use strict';

/**
 * Unit tests for src/coding/workers/scheduledGenerator.worker.js
 *
 * - ArtifactBundle.aggregate is stubbed — no DB connection required.
 * - Queue is injected via the `queue` param of runScheduledGeneration.
 * - getCurrentCounts is replaced on the module export for e2e tests.
 */

process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test   = require('node:test');
const assert = require('node:assert/strict');

// ── Stub ArtifactBundle.aggregate before loading the worker ──────────────────

const { ArtifactBundle } = require('../../coding/models');

let aggregateStub = async () => [];
ArtifactBundle.aggregate = async (...args) => aggregateStub(...args);

// ── Load module under test ────────────────────────────────────────────────────

const scheduledGenerator = require('../../coding/workers/scheduledGenerator.worker');
const {
  computeQuotaPlan,
  enqueueQuotaJobs,
  runScheduledGeneration,
  MAX_PER_RUN,
  DEFAULT_TARGET_LIBRARY_SIZE,
} = scheduledGenerator;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build zeroed-out currentCounts (all 36 buckets at 0). */
function zeroCounts() {
  const ROLE_TRACKS   = ['swe', 'ds', 'ai_eng'];
  const DRILL_SUBTYPES = ['prompt', 'verify', 'decompose', 'refactor'];
  const DIFFICULTIES  = ['easy', 'medium', 'hard'];
  const counts = {};
  for (const rt of ROLE_TRACKS) {
    counts[rt] = {};
    for (const sub of DRILL_SUBTYPES) {
      counts[rt][sub] = {};
      for (const diff of DIFFICULTIES) counts[rt][sub][diff] = 0;
    }
  }
  return counts;
}

/** Build a stub queue that collects add() calls. */
function makeStubQueue() {
  const calls = [];
  return {
    add: async (name, data) => { calls.push({ name, data }); },
    calls,
  };
}

// ── Test 1: computeQuotaPlan — empty counts, all 36 buckets at zero ───────────

test('computeQuotaPlan: all 36 buckets at 0 — plan total capped at MAX_PER_RUN', () => {
  const currentCounts = zeroCounts();
  const plan = computeQuotaPlan({ targetLibrarySize: DEFAULT_TARGET_LIBRARY_SIZE, currentCounts });

  // Total enqueue count must be capped at MAX_PER_RUN
  const total = plan.reduce((sum, e) => sum + e.count, 0);
  assert.strictEqual(total, MAX_PER_RUN,
    `total count across plan should equal MAX_PER_RUN (${MAX_PER_RUN}), got ${total}`);

  // Each entry's count must be positive
  for (const entry of plan) {
    assert.ok(entry.count > 0, `Every plan entry should have count > 0, got: ${entry.count}`);
    assert.ok(['swe', 'ds', 'ai_eng'].includes(entry.role_track),   'role_track must be valid');
    assert.ok(['prompt', 'verify', 'decompose', 'refactor'].includes(entry.drill_subtype), 'drill_subtype must be valid');
    assert.ok(['easy', 'medium', 'hard'].includes(entry.difficulty), 'difficulty must be valid');
  }
});

// ── Test 2: computeQuotaPlan — counts already at target — empty plan ──────────

test('computeQuotaPlan: all buckets at target — returns empty plan', () => {
  const BUCKETS = 3 * 4 * 3; // 36
  const targetPerBucket = Math.ceil(DEFAULT_TARGET_LIBRARY_SIZE / BUCKETS); // 4

  const currentCounts = zeroCounts();
  const ROLE_TRACKS   = ['swe', 'ds', 'ai_eng'];
  const DRILL_SUBTYPES = ['prompt', 'verify', 'decompose', 'refactor'];
  const DIFFICULTIES  = ['easy', 'medium', 'hard'];

  // Fill every bucket to exactly the target
  for (const rt of ROLE_TRACKS)
    for (const sub of DRILL_SUBTYPES)
      for (const diff of DIFFICULTIES)
        currentCounts[rt][sub][diff] = targetPerBucket;

  const plan = computeQuotaPlan({ targetLibrarySize: DEFAULT_TARGET_LIBRARY_SIZE, currentCounts });

  assert.strictEqual(plan.length, 0,
    `Expected empty plan when all buckets are at target, got ${plan.length} entries`);
});

// ── Test 3: computeQuotaPlan — partial coverage ───────────────────────────────

test('computeQuotaPlan: partial coverage — only understocked buckets appear', () => {
  const currentCounts = zeroCounts();
  const BUCKETS = 3 * 4 * 3;
  const targetPerBucket = Math.ceil(DEFAULT_TARGET_LIBRARY_SIZE / BUCKETS); // 4

  // Fill swe/prompt/easy to target
  currentCounts['swe']['prompt']['easy'] = targetPerBucket;

  const plan = computeQuotaPlan({ targetLibrarySize: DEFAULT_TARGET_LIBRARY_SIZE, currentCounts });

  // swe/prompt/easy must NOT be in the plan (it's at target)
  const atTarget = plan.find(
    e => e.role_track === 'swe' && e.drill_subtype === 'prompt' && e.difficulty === 'easy',
  );
  assert.strictEqual(atTarget, undefined,
    'swe/prompt/easy is at target and must not appear in plan');

  // Plan must not exceed MAX_PER_RUN total
  const total = plan.reduce((sum, e) => sum + e.count, 0);
  assert.ok(total <= MAX_PER_RUN,
    `plan total (${total}) must not exceed MAX_PER_RUN (${MAX_PER_RUN})`);

  // At least one understocked bucket should be in the plan (35 buckets remain at 0)
  assert.ok(plan.length > 0, 'plan should not be empty when buckets are understocked');
});

// ── Test 4: enqueueQuotaJobs — calls queue.add correct number of times ────────

test('enqueueQuotaJobs: calls queue.add N times with correct job data', async () => {
  const queue = makeStubQueue();

  const plan = [
    { role_track: 'swe',    drill_subtype: 'prompt',   difficulty: 'easy',   count: 2 },
    { role_track: 'ds',     drill_subtype: 'verify',   difficulty: 'medium', count: 1 },
    { role_track: 'ai_eng', drill_subtype: 'decompose',difficulty: 'hard',   count: 3 },
  ];

  const enqueued = await enqueueQuotaJobs(plan, queue);

  assert.strictEqual(enqueued, 6, `enqueued should be 6, got ${enqueued}`);
  assert.strictEqual(queue.calls.length, 6, `queue.add should have been called 6 times`);

  // All calls should use the job name 'generate-bundle'
  for (const call of queue.calls) {
    assert.strictEqual(call.name, 'generate-bundle',
      `job name should be "generate-bundle", got "${call.name}"`);
  }

  // Verify first job data (swe → python)
  assert.strictEqual(queue.calls[0].data.role_track,    'swe');
  assert.strictEqual(queue.calls[0].data.drill_subtype, 'prompt');
  assert.strictEqual(queue.calls[0].data.difficulty,    'easy');
  assert.strictEqual(queue.calls[0].data.language,      'python');

  // Verify DS job data (ds → python)
  assert.strictEqual(queue.calls[2].data.role_track,    'ds');
  assert.strictEqual(queue.calls[2].data.drill_subtype, 'verify');
  assert.strictEqual(queue.calls[2].data.difficulty,    'medium');
  assert.strictEqual(queue.calls[2].data.language,      'python');

  // Verify AI Eng job data (ai_eng → python)
  assert.strictEqual(queue.calls[3].data.role_track,    'ai_eng');
  assert.strictEqual(queue.calls[3].data.drill_subtype, 'decompose');
  assert.strictEqual(queue.calls[3].data.difficulty,    'hard');
  assert.strictEqual(queue.calls[3].data.language,      'python');
});

// ── Test 5: runScheduledGeneration — e2e with mocked getCurrentCounts ─────────

test('runScheduledGeneration: planned and enqueued counts match with mocked getCurrentCounts', async () => {
  const queue = makeStubQueue();

  // Temporarily replace getCurrentCounts on the module export
  const originalGetCurrentCounts = scheduledGenerator.getCurrentCounts;

  // All buckets at 0 → plan will generate up to MAX_PER_RUN jobs
  scheduledGenerator.getCurrentCounts = async () => zeroCounts();

  try {
    const result = await runScheduledGeneration({ queue });

    assert.ok(typeof result === 'object' && result !== null,
      'runScheduledGeneration should return an object');
    assert.ok('planned' in result,  'result must have "planned" key');
    assert.ok('enqueued' in result, 'result must have "enqueued" key');

    // With all buckets at 0, the plan should be capped at MAX_PER_RUN
    assert.strictEqual(result.planned, MAX_PER_RUN,
      `planned should equal MAX_PER_RUN (${MAX_PER_RUN}), got ${result.planned}`);
    assert.strictEqual(result.enqueued, MAX_PER_RUN,
      `enqueued should equal MAX_PER_RUN (${MAX_PER_RUN}), got ${result.enqueued}`);
    assert.strictEqual(result.enqueued, result.planned,
      'enqueued must equal planned in success case');

    // Queue should have been called planned times
    assert.strictEqual(queue.calls.length, result.planned,
      `queue.add call count (${queue.calls.length}) should match planned (${result.planned})`);
  } finally {
    scheduledGenerator.getCurrentCounts = originalGetCurrentCounts;
  }
});

// ── Test 6: runScheduledGeneration — empty plan when library is full ──────────

test('runScheduledGeneration: returns { planned:0, enqueued:0 } when library is fully stocked', async () => {
  const queue = makeStubQueue();
  const BUCKETS = 3 * 4 * 3;
  const targetPerBucket = Math.ceil(DEFAULT_TARGET_LIBRARY_SIZE / BUCKETS);

  const originalGetCurrentCounts = scheduledGenerator.getCurrentCounts;
  const fullCounts = zeroCounts();
  const ROLE_TRACKS    = ['swe', 'ds', 'ai_eng'];
  const DRILL_SUBTYPES = ['prompt', 'verify', 'decompose', 'refactor'];
  const DIFFICULTIES   = ['easy', 'medium', 'hard'];
  for (const rt of ROLE_TRACKS)
    for (const sub of DRILL_SUBTYPES)
      for (const diff of DIFFICULTIES)
        fullCounts[rt][sub][diff] = targetPerBucket;

  scheduledGenerator.getCurrentCounts = async () => fullCounts;

  try {
    const result = await runScheduledGeneration({ queue });

    assert.strictEqual(result.planned,  0, `planned should be 0 when library is full, got ${result.planned}`);
    assert.strictEqual(result.enqueued, 0, `enqueued should be 0 when library is full, got ${result.enqueued}`);
    assert.strictEqual(queue.calls.length, 0, 'queue.add should not be called when library is full');
  } finally {
    scheduledGenerator.getCurrentCounts = originalGetCurrentCounts;
  }
});
