'use strict';

/**
 * Unit tests for the LLM router service.
 * These tests only verify the routing table — no actual LLM calls are made.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// The service under test
const { getModelForTask, getRoutingTable } = require('../../coding/services/llmRouter');

// ── getModelForTask ───────────────────────────────────────────────────────────

test('getModelForTask: content_generator_draft → anthropic + opus model', () => {
  const result = getModelForTask('content_generator_draft');
  assert.strictEqual(result.provider, 'anthropic');
  assert.match(result.model, /opus/);
});

test('getModelForTask: content_validator_cross → google + gemini-2.5-pro model', () => {
  const result = getModelForTask('content_validator_cross');
  assert.strictEqual(result.provider, 'google');
  assert.match(result.model, /gemini-2\.5-pro/);
});

test('getModelForTask: drill_grade_prompt → anthropic + haiku model', () => {
  const result = getModelForTask('drill_grade_prompt');
  assert.strictEqual(result.provider, 'anthropic');
  assert.match(result.model, /haiku/);
});

test('getModelForTask: compass_coder → anthropic + sonnet model', () => {
  const result = getModelForTask('compass_coder');
  assert.strictEqual(result.provider, 'anthropic');
  assert.match(result.model, /sonnet/);
});

test('getModelForTask: unknown task ID throws', () => {
  assert.throws(
    () => getModelForTask('does_not_exist'),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
});

// ── getRoutingTable ───────────────────────────────────────────────────────────

test('getRoutingTable: returns object with all 14 task IDs', () => {
  const table = getRoutingTable();
  assert.strictEqual(typeof table, 'object');
  assert.ok(table !== null);

  const EXPECTED_TASK_IDS = [
    'content_generator_draft',
    'content_validator_cross',
    'drill_promotion_judge',
    'capstone_quality_cross',
    'reference_solution_solver',
    'drill_grade_prompt',
    'drill_grade_verify',
    'drill_grade_decompose',
    'drill_grade_refactor',
    'capstone_evaluator',
    'seeded_mistake_generator',
    'hidden_test_generator',
    'compass_coder',
    'review_triage_brief',
  ];

  for (const taskId of EXPECTED_TASK_IDS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(table, taskId),
      `Routing table is missing task ID: ${taskId}`
    );
  }

  assert.strictEqual(Object.keys(table).length, EXPECTED_TASK_IDS.length,
    'Routing table should contain exactly 14 entries');
});

test('getModelForTask: review_triage_brief → anthropic + sonnet model', () => {
  const result = getModelForTask('review_triage_brief');
  assert.strictEqual(result.provider, 'anthropic');
  assert.match(result.model, /sonnet/);
});
