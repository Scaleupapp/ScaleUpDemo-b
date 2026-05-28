'use strict';

/**
 * WS4 unit + pipeline tests — covers the evaluator's pure functions and the
 * orchestrator's branching behavior with mocked LLM + mocked harness.
 *
 * Three suites:
 *   1. diff.diffTrees — added / deleted / modified file accounting
 *   2. compassLog.analyse — turn counting + ratios + rework-cycle detection
 *   3. anchorDrift.check — drift threshold + grouped-anchor weighted average
 *   4. scorer.score — JSON envelope validation; rejects malformed Sonnet output
 *   5. costTracker.computeCost — per-model pricing math
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// 1. diff.diffTrees
// ---------------------------------------------------------------------------

const { diffTrees } = require('../../coding/services/capstoneEvaluator/diff');

test('diff: detects added / deleted / modified files', () => {
  const starter = {
    files: [
      { path: 'a.js', content: 'console.log(1)' },
      { path: 'b.js', content: 'console.log(2)' },
    ],
  };
  const final = {
    files: [
      { path: 'a.js', content: 'console.log(1) // edited' }, // modified
      { path: 'c.js', content: 'console.log(3)' }, // added; b.js deleted
    ],
  };
  const d = diffTrees(starter, final);
  assert.equal(d.files_changed, 3);
  assert.deepEqual(d.files_added, ['c.js']);
  assert.deepEqual(d.files_deleted, ['b.js']);
  assert.ok(d.lines_added >= 2, 'should count added lines');
  assert.ok(d.lines_removed >= 1, 'should count removed lines');
  assert.match(d.unified_diff, /\+\+\+ b\/a\.js/);
  assert.match(d.unified_diff, /\+\+\+ b\/c\.js/);
});

test('diff: unchanged files do not inflate the change count', () => {
  const same = { files: [{ path: 'a.js', content: 'x' }] };
  const d = diffTrees(same, same);
  assert.equal(d.files_changed, 0);
  assert.equal(d.lines_added, 0);
  assert.equal(d.lines_removed, 0);
});

// ---------------------------------------------------------------------------
// 2. compassLog.analyse — fed a synthetic stream
// ---------------------------------------------------------------------------

const compassLog = require('../../coding/services/capstoneEvaluator/compassLog');
const s3 = require('../../config/s3');

test('compassLog: counts turns and detects rework cycles', async (t) => {
  const stream = [
    { type: 'compass_turn', payload: { resolution: 'accept' } },
    { type: 'compass_turn', payload: { resolution: 'accept' } },
    { type: 'compass_turn', payload: { resolution: 'edit' } },
    { type: 'compass_turn', payload: { resolution: 'reject' } },
    { type: 'compass_turn', payload: { resolution: 'reject' } }, // 1st cycle starts
    { type: 'compass_turn', payload: { resolution: 'reject' } }, // still same cycle
    { type: 'compass_turn', payload: { resolution: 'accept' } },
    { type: 'paste', payload: { size: 240 } },
    { type: 'tab_blur', payload: { ms: 1800 } },
  ];
  const buf = Buffer.from(stream.map((e) => JSON.stringify(e)).join('\n'));
  const orig = s3.downloadBuffer;
  s3.downloadBuffer = async () => buf;
  t.after(() => {
    s3.downloadBuffer = orig;
  });

  const r = await compassLog.analyse('fake-key');
  assert.equal(r.turn_count, 7);
  assert.equal(r.accept_count, 3);
  assert.equal(r.edit_count, 1);
  assert.equal(r.reject_count, 3);
  assert.equal(r.rework_cycles, 1); // only the second consecutive reject increments
  assert.equal(r.paste_count, 1);
  assert.equal(r.tab_blur_count, 1);
  assert.equal(r.accept_ratio, Math.round((3 / 7) * 1000) / 1000);
});

test('compassLog: returns zero state when stream is empty', async (t) => {
  const orig = s3.downloadBuffer;
  s3.downloadBuffer = async () => Buffer.alloc(0);
  t.after(() => {
    s3.downloadBuffer = orig;
  });
  const r = await compassLog.analyse('fake-key');
  assert.equal(r.turn_count, 0);
  assert.equal(r.accept_ratio, 0);
});

// ---------------------------------------------------------------------------
// 3. anchorDrift.check — pure-function part (no DB writes)
// ---------------------------------------------------------------------------

test('anchorDrift: groups anchors by dimension via weighted average and flags > 2pt drift', async () => {
  // Mock EvaluationAnchor model so check() doesn't touch Mongo.
  const anchorModulePath = require.resolve('../../coding/services/capstoneEvaluator/anchorDrift');
  const modelPath = require.resolve('../../coding/models/evaluationAnchor.model');
  const orig = { module: require.cache[anchorModulePath], model: require.cache[modelPath] };

  let upserts = 0;
  const mockModel = {
    findOneAndUpdate: async () => {
      upserts += 1;
      return {};
    },
  };
  require.cache[modelPath] = { exports: mockModel, loaded: true, id: modelPath };
  delete require.cache[anchorModulePath];

  try {
    const { check, ANCHOR_DRIFT_THRESHOLD } = require(anchorModulePath);
    assert.equal(ANCHOR_DRIFT_THRESHOLD, 2.0);

    // Two anchors on 'correctness': weighted avg = (8*2 + 6*1)/3 = 7.33
    // Evaluator scored 4.0 → delta 3.33 → drift.
    // One anchor on 'code_quality' at 7 — evaluator 6 → delta 1 → no drift.
    const result = await check({
      bundleId: 'b1',
      rubricAnchors: [
        { dimension: 'correctness', expected_score: 8, weight: 2 },
        { dimension: 'correctness', expected_score: 6, weight: 1 },
        { dimension: 'code_quality', expected_score: 7, weight: 1 },
      ],
      dimensionScores: { correctness: 4, code_quality: 6 },
      evaluatorModel: 'claude-sonnet-4-6',
    });

    assert.equal(result.driftDetected, true);
    assert.equal(result.driftedDimensions.length, 1);
    assert.equal(result.driftedDimensions[0].dimension, 'correctness');
    assert.ok(result.driftedDimensions[0].delta > 2.0);
    assert.equal(upserts, 1, 'one upsert per drifted dimension');
  } finally {
    if (orig.module) require.cache[anchorModulePath] = orig.module;
    else delete require.cache[anchorModulePath];
    if (orig.model) require.cache[modelPath] = orig.model;
    else delete require.cache[modelPath];
  }
});

// ---------------------------------------------------------------------------
// 4. scorer.score — JSON validation (no DB, no LLM)
// ---------------------------------------------------------------------------

test('scorer: rejects malformed LLM output', async () => {
  // Stub the llmRouter to return well-formed text that fails the contract
  // (e.g. missing dimension_scores.correctness).
  const scorerPath = require.resolve('../../coding/services/capstoneEvaluator/scorer');
  const routerPath = require.resolve('../../coding/services/llmRouter');
  const costPath = require.resolve('../../coding/services/costTracker');
  const orig = {
    s: require.cache[scorerPath],
    r: require.cache[routerPath],
    c: require.cache[costPath],
  };

  require.cache[routerPath] = {
    exports: {
      llmCall: async () => ({
        content: [{ type: 'text', text: '{"overall_score": 80}' }], // missing fields
        usage: { input_tokens: 100, output_tokens: 50 },
        _meta: { taskId: 'capstone_evaluator', provider: 'anthropic', model: 'claude-sonnet-4-6', duration_ms: 100 },
      }),
    },
    loaded: true,
    id: routerPath,
  };
  require.cache[costPath] = {
    exports: { recordSpend: async () => ({ cost_usd: 0 }), sessionCostUsd: async () => 0 },
    loaded: true,
    id: costPath,
  };
  delete require.cache[scorerPath];

  try {
    const { score } = require(scorerPath);
    await assert.rejects(
      () =>
        score({
          bundle: { brief: 'x', acceptance_criteria: [], language: 'python', difficulty: 'easy', role_track: 'swe', time_budget_minutes: 60 },
          diff: { files_changed: 0, files_added: [], files_deleted: [], lines_added: 0, lines_removed: 0, unified_diff: '' },
          harness: { visible: [], hidden: [], lint: { passed: true, output: '', durationMs: 0 } },
          compassLog: { turn_count: 0, accept_count: 0, edit_count: 0, reject_count: 0, rework_cycles: 0, paste_count: 0, tab_blur_count: 0, accept_ratio: 0, edit_ratio: 0, reject_ratio: 0, turns: [] },
        }),
      /missing|invalid/
    );
  } finally {
    if (orig.s) require.cache[scorerPath] = orig.s; else delete require.cache[scorerPath];
    if (orig.r) require.cache[routerPath] = orig.r; else delete require.cache[routerPath];
    if (orig.c) require.cache[costPath] = orig.c; else delete require.cache[costPath];
  }
});

test('scorer: accepts well-formed LLM output and tags evaluator_model', async () => {
  const scorerPath = require.resolve('../../coding/services/capstoneEvaluator/scorer');
  const routerPath = require.resolve('../../coding/services/llmRouter');
  const costPath = require.resolve('../../coding/services/costTracker');
  const orig = {
    s: require.cache[scorerPath],
    r: require.cache[routerPath],
    c: require.cache[costPath],
  };

  const wellFormed = {
    dimension_scores: {
      correctness: 8,
      code_quality: 7,
      ai_pair_effectiveness: 6,
      verification_discipline: 7,
      decomposition: 8,
      reflection_quality: 5,
    },
    overall_score: 72,
    strengths: ['x'],
    gaps: ['y'],
    interview_parallel: 'z',
    integrity_confidence: 'high',
    evidence_notes: 'a',
  };
  require.cache[routerPath] = {
    exports: {
      llmCall: async () => ({
        content: [{ type: 'text', text: JSON.stringify(wellFormed) }],
        usage: { input_tokens: 100, output_tokens: 50 },
        _meta: { taskId: 'capstone_evaluator', provider: 'anthropic', model: 'claude-sonnet-4-6', duration_ms: 100 },
      }),
    },
    loaded: true,
    id: routerPath,
  };
  require.cache[costPath] = {
    exports: { recordSpend: async () => ({ cost_usd: 0 }), sessionCostUsd: async () => 0 },
    loaded: true,
    id: costPath,
  };
  delete require.cache[scorerPath];

  try {
    const { score } = require(scorerPath);
    const r = await score({
      bundle: { brief: 'x', acceptance_criteria: [], language: 'python', difficulty: 'easy', role_track: 'swe', time_budget_minutes: 60 },
      diff: { files_changed: 0, files_added: [], files_deleted: [], lines_added: 0, lines_removed: 0, unified_diff: '' },
      harness: { visible: [], hidden: [], lint: { passed: true, output: '', durationMs: 0 } },
      compassLog: { turn_count: 0, accept_count: 0, edit_count: 0, reject_count: 0, rework_cycles: 0, paste_count: 0, tab_blur_count: 0, accept_ratio: 0, edit_ratio: 0, reject_ratio: 0, turns: [] },
    });
    assert.equal(r.overall_score, 72);
    assert.equal(r.evaluator_model, 'claude-sonnet-4-6');
    assert.equal(r.integrity_confidence, 'high');
  } finally {
    if (orig.s) require.cache[scorerPath] = orig.s; else delete require.cache[scorerPath];
    if (orig.r) require.cache[routerPath] = orig.r; else delete require.cache[routerPath];
    if (orig.c) require.cache[costPath] = orig.c; else delete require.cache[costPath];
  }
});

// ---------------------------------------------------------------------------
// 5. costTracker.computeCost — per-model pricing math
// ---------------------------------------------------------------------------

const { computeCost, PRICING_PER_M } = require('../../coding/services/costTracker');

test('costTracker: known model — pricing matches the table', () => {
  // Sonnet 4.6: 3/M in + 15/M out
  // 100k in + 50k out = 100_000 * 3 / 1_000_000 + 50_000 * 15 / 1_000_000
  //                   = 0.30 + 0.75 = 1.05
  const c = computeCost('claude-sonnet-4-6', { input_tokens: 100_000, output_tokens: 50_000 });
  assert.equal(c, 1.05);
});

test('costTracker: unknown model returns 0 (no fail-loud)', () => {
  assert.equal(computeCost('not-a-real-model', { input_tokens: 1000, output_tokens: 1000 }), 0);
});

test('costTracker: pricing table includes every routed model', () => {
  // Anchor — every model the evaluator can route to must have pricing.
  const routedModels = [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'gemini-2.5-pro',
  ];
  for (const m of routedModels) {
    assert.ok(PRICING_PER_M[m], `missing pricing entry for ${m}`);
  }
});
