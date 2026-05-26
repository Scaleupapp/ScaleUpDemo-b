'use strict';

/**
 * Unit tests for src/coding/services/contentGenerator.js
 *
 * - ArtifactBundle static methods are stubbed — no DB connection required.
 * - llmRouter.llmCall is replaced with a deterministic stub before the module
 *   under test is loaded.
 * - nearestSeeds is exercised through the module-level export for the happy-path
 *   tests; for generate() tests we replace the export so generate() uses the stub.
 */

process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test   = require('node:test');
const assert = require('node:assert/strict');

// ── LLM stub — patched before the service is loaded ──────────────────────────

const llmRouter = require('../../coding/services/llmRouter');

// Default stub response — overridden per-test where needed
let stubLlmResponse = null;

llmRouter.llmCall = async () => {
  if (!stubLlmResponse) throw new Error('stubLlmResponse not set');
  return stubLlmResponse;
};

// ── Model stub ────────────────────────────────────────────────────────────────

const { ArtifactBundle } = require('../../coding/models');

// Captured create() argument — filled by the stub
let capturedCreate = null;

ArtifactBundle.create = async (doc) => {
  capturedCreate = doc;
  return doc; // echo back as saved doc
};

// Default stub for ArtifactBundle.find — returns an empty chain
// Individual tests override as needed
const defaultFindChain = () => ({
  limit: () => ({ lean: () => Promise.resolve([]) }),
});
ArtifactBundle.find = defaultFindChain;

// ── Module under test — loaded AFTER stubs are in place ──────────────────────

const { generate, nearestSeeds, extractJson } =
  require('../../coding/services/contentGenerator');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * A minimal ArtifactBundle that passes Joi validation.
 * Used both as the seed and as the LLM response body.
 */
const MINIMAL_VALID_BUNDLE = {
  type: 'drill',
  drill_subtype: 'prompt',
  role_track: 'swe',
  language: 'python',
  difficulty: 'easy',
  time_budget_minutes: 10,
  brief: 'Write a prompt to ask an LLM to reverse a string, handling edge cases.',
  acceptance_criteria: ['Returns reversed string'],
  reference_solution: { files: [{ path: 'solution.py', content: 'def solve(): pass' }] },
  visible_tests: [],
  hidden_tests: [],
  seeded_mistakes: [],
  rubric_anchors: [],
  expected_meta_skill_signals: {
    good_prompts_look_like: [],
    common_verification_traps: [],
    decomposition_reference: [],
  },
  difficulty_signals: {
    token_count: 100,
    branching_complexity: 1,
    edge_cases: 2,
    known_hard_patterns: [],
  },
  // content_hash is added by generate() — NOT present here (as the LLM would return)
};

// ── 1. extractJson — plain text ───────────────────────────────────────────────

test('extractJson: parses plain text JSON block', () => {
  const content = [{ type: 'text', text: '{"foo":1}' }];
  const result = extractJson(content);
  assert.deepStrictEqual(result, { foo: 1 });
});

// ── 2. extractJson — fenced ───────────────────────────────────────────────────

test('extractJson: strips ```json fences before parsing', () => {
  const content = [{ type: 'text', text: '```json\n{"foo":2}\n```' }];
  const result = extractJson(content);
  assert.deepStrictEqual(result, { foo: 2 });
});

// ── 3. extractJson — no text block ────────────────────────────────────────────

test('extractJson: throws when there is no text block in content', () => {
  const content = [{ type: 'tool_use', id: 'x', name: 'code_execution', input: {} }];
  assert.throws(
    () => extractJson(content),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('text block'), `Expected "text block" in: ${err.message}`);
      return true;
    },
  );
});

// ── 4. nearestSeeds queries with right filters ────────────────────────────────

test('nearestSeeds: queries ArtifactBundle with correct filter including human_reviewed', async () => {
  let capturedFilter = null;
  let capturedLimit  = null;

  ArtifactBundle.find = (filter) => {
    capturedFilter = filter;
    return {
      limit: (n) => {
        capturedLimit = n;
        return {
          lean: () => Promise.resolve([
            { ...MINIMAL_VALID_BUNDLE, status: 'active', 'generated_by.human_reviewed': true },
            { ...MINIMAL_VALID_BUNDLE, status: 'active', 'generated_by.human_reviewed': true },
            { ...MINIMAL_VALID_BUNDLE, status: 'active', 'generated_by.human_reviewed': true },
          ]),
        };
      },
    };
  };

  try {
    await nearestSeeds({ role_track: 'swe', drill_subtype: 'prompt', difficulty: 'easy' });

    assert.ok(capturedFilter, 'ArtifactBundle.find should have been called');
    assert.strictEqual(capturedFilter.type,            'drill',  'filter.type must be "drill"');
    assert.strictEqual(capturedFilter.role_track,      'swe',   'filter.role_track must be "swe"');
    assert.strictEqual(capturedFilter.drill_subtype,   'prompt','filter.drill_subtype must be "prompt"');
    assert.strictEqual(capturedFilter.difficulty,      'easy',  'filter.difficulty must be "easy"');
    assert.strictEqual(capturedFilter.status,          'active','filter.status must be "active"');
    assert.strictEqual(
      capturedFilter['generated_by.human_reviewed'],
      true,
      'filter must include generated_by.human_reviewed: true',
    );
    assert.strictEqual(capturedLimit, 3, 'should request exactly 3 seeds (k=3)');
  } finally {
    ArtifactBundle.find = defaultFindChain;
  }
});

// ── 5. generate — happy path ──────────────────────────────────────────────────

test('generate: happy path — saved doc has content_hash, generated_by.generator_model, status=draft', async () => {
  // Arrange: one seed, valid LLM output (bundle without content_hash/status/generated_by)
  const fakeSeed = { ...MINIMAL_VALID_BUNDLE, status: 'active' };

  ArtifactBundle.find = () => ({
    limit: () => ({ lean: () => Promise.resolve([fakeSeed, fakeSeed, fakeSeed]) }),
  });

  stubLlmResponse = {
    content: [{ type: 'text', text: JSON.stringify(MINIMAL_VALID_BUNDLE) }],
    _meta: { provider: 'anthropic', model: 'claude-opus-4-7', taskId: 'content_generator_draft', duration_ms: 500 },
  };
  capturedCreate = null;

  try {
    const saved = await generate({
      role_track:    'swe',
      drill_subtype: 'prompt',
      difficulty:    'easy',
      language:      'python',
      topic_hint:    'string manipulation',
    });

    assert.ok(saved, 'generate should return a saved doc');
    assert.ok(typeof saved.content_hash === 'string' && saved.content_hash.length === 64,
      `content_hash should be a 64-char hex string, got: ${saved.content_hash}`);
    assert.strictEqual(saved.status, 'draft', 'status should be "draft"');
    assert.ok(saved.generated_by, 'generated_by should be present');
    assert.strictEqual(saved.generated_by.generator_model, 'claude-opus-4-7',
      'generated_by.generator_model should match LLM meta.model');
    assert.strictEqual(saved.generated_by.human_reviewed, false,
      'human_reviewed should be false on a new draft');
    assert.ok(capturedCreate, 'ArtifactBundle.create should have been called');
  } finally {
    ArtifactBundle.find = defaultFindChain;
    stubLlmResponse = null;
  }
});

// ── 6. generate — no seeds ────────────────────────────────────────────────────

test('generate: throws with helpful message when no seed bundles found', async () => {
  ArtifactBundle.find = () => ({
    limit: () => ({ lean: () => Promise.resolve([]) }),
  });

  try {
    await assert.rejects(
      () => generate({
        role_track:    'swe',
        drill_subtype: 'prompt',
        difficulty:    'easy',
        language:      'python',
      }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes('seed'),
          `Error message should mention "seed", got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    ArtifactBundle.find = defaultFindChain;
  }
});

// ── 7. generate — invalid LLM output ─────────────────────────────────────────

test('generate: throws Joi validation error when LLM returns bundle missing required "brief"', async () => {
  const fakeSeed = { ...MINIMAL_VALID_BUNDLE, status: 'active' };
  ArtifactBundle.find = () => ({
    limit: () => ({ lean: () => Promise.resolve([fakeSeed, fakeSeed, fakeSeed]) }),
  });

  // Return a bundle that's missing `brief` — should fail Joi validation
  const invalidBundle = { ...MINIMAL_VALID_BUNDLE };
  delete invalidBundle.brief;

  stubLlmResponse = {
    content: [{ type: 'text', text: JSON.stringify(invalidBundle) }],
    _meta: { provider: 'anthropic', model: 'claude-opus-4-7', taskId: 'content_generator_draft', duration_ms: 300 },
  };

  try {
    await assert.rejects(
      () => generate({
        role_track:    'swe',
        drill_subtype: 'prompt',
        difficulty:    'easy',
        language:      'python',
      }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('Joi validation') || err.message.includes('validation'),
          `Error message should mention validation, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    ArtifactBundle.find = defaultFindChain;
    stubLlmResponse = null;
  }
});
