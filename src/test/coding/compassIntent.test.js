'use strict';

/**
 * Tests for src/services/v2/compassIntent.js
 *
 * Strategy: test maybeIsDrillRequest directly (pure function), and test
 * detectDrillRequest by stubbing llmCall and parseLLMJson in require.cache.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub-for-tests';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function stubModule(absolutePath, stub) {
  delete require.cache[absolutePath];
  require.cache[absolutePath] = {
    id: absolutePath,
    filename: absolutePath,
    loaded: true,
    exports: stub,
  };
}

const INTENT_PATH = path.resolve(
  __dirname,
  '../../services/v2/compassIntent.js'
);

const LLM_ROUTER_PATH = path.resolve(
  __dirname,
  '../../coding/services/llmRouter.js'
);

const PARSE_LLM_JSON_PATH = path.resolve(
  __dirname,
  '../../coding/services/drillGrader/parseLLMJson.js'
);

function loadIntent() {
  delete require.cache[INTENT_PATH];
  return require(INTENT_PATH);
}

// ---------------------------------------------------------------------------
// maybeIsDrillRequest — keyword pre-filter tests (sync, pure function)
// ---------------------------------------------------------------------------

test('maybeIsDrillRequest: returns true for "give me a drill"', () => {
  const { maybeIsDrillRequest } = loadIntent();
  assert.strictEqual(maybeIsDrillRequest('give me a drill'), true);
});

test('maybeIsDrillRequest: returns true for "I want more practice"', () => {
  const { maybeIsDrillRequest } = loadIntent();
  assert.strictEqual(maybeIsDrillRequest('I want more practice on closures'), true);
});

test('maybeIsDrillRequest: returns true for "coding exercise"', () => {
  const { maybeIsDrillRequest } = loadIntent();
  assert.strictEqual(maybeIsDrillRequest('can I get a coding exercise?'), true);
});

test('maybeIsDrillRequest: returns true for "prompt drill"', () => {
  const { maybeIsDrillRequest } = loadIntent();
  assert.strictEqual(maybeIsDrillRequest('start a prompt drill'), true);
});

test('maybeIsDrillRequest: returns true for "bug hunt"', () => {
  const { maybeIsDrillRequest } = loadIntent();
  assert.strictEqual(maybeIsDrillRequest('let\'s do a bug hunt today'), true);
});

test('maybeIsDrillRequest: returns false for content question', () => {
  const { maybeIsDrillRequest } = loadIntent();
  assert.strictEqual(maybeIsDrillRequest('what is recursion?'), false);
});

test('maybeIsDrillRequest: returns false for plan question', () => {
  const { maybeIsDrillRequest } = loadIntent();
  assert.strictEqual(maybeIsDrillRequest('how many weeks are left in my plan?'), false);
});

test('maybeIsDrillRequest: returns false for empty string', () => {
  const { maybeIsDrillRequest } = loadIntent();
  assert.strictEqual(maybeIsDrillRequest(''), false);
});

test('maybeIsDrillRequest: returns false for null', () => {
  const { maybeIsDrillRequest } = loadIntent();
  assert.strictEqual(maybeIsDrillRequest(null), false);
});

test('maybeIsDrillRequest: case-insensitive — "DRILL" → true', () => {
  const { maybeIsDrillRequest } = loadIntent();
  assert.strictEqual(maybeIsDrillRequest('Give me a DRILL'), true);
});

// ---------------------------------------------------------------------------
// detectDrillRequest — async, stubs llmCall + parseLLMJson
// ---------------------------------------------------------------------------

test('detectDrillRequest: returns null for non-drill message (no keywords)', async () => {
  // "what is recursion?" has no keywords → skips LLM entirely
  stubModule(LLM_ROUTER_PATH, {
    llmCall: async () => { throw new Error('should not call LLM for non-keyword message'); },
  });

  const { detectDrillRequest } = loadIntent();
  const result = await detectDrillRequest('what is recursion?');
  assert.strictEqual(result, null);
});

test('detectDrillRequest: returns action object for clear drill request (stub LLM)', async () => {
  stubModule(LLM_ROUTER_PATH, {
    llmCall: async () => ({ content: '{"is_drill_request":true,"drill_subtype":"verify","difficulty":"medium","topic_hint":null}' }),
  });
  stubModule(PARSE_LLM_JSON_PATH, {
    parseLLMJson: (content) => JSON.parse(content),
  });

  const { detectDrillRequest } = loadIntent();
  const result = await detectDrillRequest('give me a verify drill on arrays');

  assert.ok(result !== null, 'should return non-null action');
  assert.strictEqual(result.type, 'request_drill');
  assert.strictEqual(result.drill_subtype, 'verify');
  assert.strictEqual(result.difficulty, 'medium');
  assert.strictEqual(result.topic_hint, null);
});

test('detectDrillRequest: returns null when LLM says is_drill_request: false', async () => {
  stubModule(LLM_ROUTER_PATH, {
    llmCall: async () => ({ content: '{"is_drill_request":false}' }),
  });
  stubModule(PARSE_LLM_JSON_PATH, {
    parseLLMJson: (content) => JSON.parse(content),
  });

  // "give me" keyword fires the pre-filter, but LLM says not a drill request
  const { detectDrillRequest } = loadIntent();
  const result = await detectDrillRequest('give me a hint about binary trees');

  assert.strictEqual(result, null);
});

test('detectDrillRequest: handles LLM error gracefully — returns null', async () => {
  stubModule(LLM_ROUTER_PATH, {
    llmCall: async () => { throw new Error('network timeout'); },
  });

  // "drill" keyword fires the pre-filter → LLM is called → LLM throws
  const { detectDrillRequest } = loadIntent();
  let result;
  // Should NOT throw — error is caught internally
  result = await detectDrillRequest('I want a drill');
  assert.strictEqual(result, null, 'LLM error should return null, not throw');
});

test('detectDrillRequest: returns null when parseLLMJson throws', async () => {
  stubModule(LLM_ROUTER_PATH, {
    llmCall: async () => ({ content: 'not-valid-json' }),
  });
  stubModule(PARSE_LLM_JSON_PATH, {
    parseLLMJson: () => { throw new SyntaxError('bad json'); },
  });

  const { detectDrillRequest } = loadIntent();
  const result = await detectDrillRequest('give me a drill');
  assert.strictEqual(result, null);
});

test('detectDrillRequest: extracts topic_hint when LLM provides one', async () => {
  stubModule(LLM_ROUTER_PATH, {
    llmCall: async () => ({
      content: '{"is_drill_request":true,"drill_subtype":"prompt","difficulty":null,"topic_hint":"binary search"}',
    }),
  });
  stubModule(PARSE_LLM_JSON_PATH, {
    parseLLMJson: (content) => JSON.parse(content),
  });

  const { detectDrillRequest } = loadIntent();
  const result = await detectDrillRequest('give me a practice drill on binary search');

  assert.ok(result !== null);
  assert.strictEqual(result.type, 'request_drill');
  assert.strictEqual(result.drill_subtype, 'prompt');
  assert.strictEqual(result.difficulty, null);
  assert.strictEqual(result.topic_hint, 'binary search');
});

test('detectDrillRequest: null drill_subtype + null difficulty when LLM leaves them unspecified', async () => {
  stubModule(LLM_ROUTER_PATH, {
    llmCall: async () => ({
      content: '{"is_drill_request":true,"drill_subtype":null,"difficulty":null,"topic_hint":null}',
    }),
  });
  stubModule(PARSE_LLM_JSON_PATH, {
    parseLLMJson: (content) => JSON.parse(content),
  });

  const { detectDrillRequest } = loadIntent();
  const result = await detectDrillRequest('can I get another one?');

  assert.ok(result !== null);
  assert.strictEqual(result.drill_subtype, null);
  assert.strictEqual(result.difficulty, null);
  assert.strictEqual(result.topic_hint, null);
});
