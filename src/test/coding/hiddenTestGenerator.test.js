'use strict';

/**
 * Block 5 (Wave 2) — independent hidden-test generation.
 *
 * generateIndependentHiddenTests routes through the `hidden_test_generator`
 * llmRouter task (cross-family model). llmCall is stubbed BEFORE the module
 * under test loads — no network / DB.
 */

process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test = require('node:test');
const assert = require('node:assert/strict');

const llmRouter = require('../../coding/services/llmRouter');

let stubResponse = null;
let capturedCall = null;
llmRouter.llmCall = async (args) => {
  capturedCall = args;
  if (typeof stubResponse === 'function') return stubResponse(args);
  return stubResponse;
};

const { generateIndependentHiddenTests } = require('../../coding/services/contentGenerator');

const DRAFT = {
  language: 'python',
  difficulty: 'medium',
  brief: 'Implement a rate limiter.',
  acceptance_criteria: ['Sliding window', 'Thread safe'],
  starter_repo: { files: [{ path: 'limiter.py', content: '# TODO' }] },
  visible_tests: [{ name: 'test_basic', command: 'pytest test_basic.py' }],
  hidden_tests: [{ name: 'author_hidden', command: 'pytest test_author.py' }],
  reference_solution: { files: [{ path: 'limiter.py', content: 'class Limiter: ...' }] },
};

function geminiJson(obj) {
  // Gemini shape: { content: { parts: [{ text }] } }
  return { content: { parts: [{ text: JSON.stringify(obj) }] } };
}

test('routes through the hidden_test_generator task and returns cleaned tests', async () => {
  stubResponse = geminiJson({
    hidden_tests: [
      { name: 'test_burst_boundary', command: 'pytest test_hidden_1.py', expected_exit_code: 0 },
      { name: 'test_clock_skew', command: 'pytest test_hidden_2.py' },
      { name: 'test_concurrent', command: 'pytest test_hidden_3.py', expected_exit_code: '0' },
    ],
  });
  capturedCall = null;

  const tests = await generateIndependentHiddenTests(DRAFT, { minCount: 3 });
  assert.equal(capturedCall.taskId, 'hidden_test_generator', 'must use the independent-model route');
  assert.equal(tests.length, 3);
  assert.deepEqual(tests[0], { name: 'test_burst_boundary', command: 'pytest test_hidden_1.py', expected_exit_code: 0 });
  assert.equal(tests[1].expected_exit_code, 0, 'missing exit code defaults to 0');
  assert.equal(tests[2].expected_exit_code, 0, 'string exit code coerced');
});

test('drops tests colliding with visible test names and malformed entries', async () => {
  stubResponse = geminiJson({
    hidden_tests: [
      { name: 'test_basic', command: 'pytest x.py' },        // collides with visible
      { name: '', command: 'pytest y.py' },                  // malformed
      { name: 'ok_1', command: 'pytest a.py' },
      { name: 'ok_2', command: 'pytest b.py' },
      { name: 'ok_3', command: 'pytest c.py' },
    ],
  });
  const tests = await generateIndependentHiddenTests(DRAFT, { minCount: 3 });
  assert.deepEqual(tests.map((t) => t.name), ['ok_1', 'ok_2', 'ok_3']);
});

test('throws when fewer than minCount usable tests come back', async () => {
  stubResponse = geminiJson({ hidden_tests: [{ name: 'only_one', command: 'pytest a.py' }] });
  await assert.rejects(
    () => generateIndependentHiddenTests(DRAFT, { minCount: 3 }),
    /only 1 usable/
  );
});

test('throws on non-JSON responses (caller fail-opens to author tests)', async () => {
  stubResponse = { content: { parts: [{ text: 'I refuse to answer in JSON' }] } };
  await assert.rejects(() => generateIndependentHiddenTests(DRAFT, { minCount: 3 }));
});

test('handles fenced JSON and Anthropic-shaped content arrays', async () => {
  stubResponse = {
    content: [{ type: 'text', text: '```json\n' + JSON.stringify({
      hidden_tests: [
        { name: 'a', command: 'pytest a.py' },
        { name: 'b', command: 'pytest b.py' },
        { name: 'c', command: 'pytest c.py' },
      ],
    }) + '\n```' }],
  };
  const tests = await generateIndependentHiddenTests(DRAFT, { minCount: 3 });
  assert.equal(tests.length, 3);
});
