const test = require('node:test');
const assert = require('node:assert');

// Stub openai before requiring the service.
const openaiPath = require.resolve('../config/openai');
let mockOpenAICreate;
require.cache[openaiPath] = {
  exports: { chat: { completions: { create: (...args) => mockOpenAICreate(...args) } } },
  loaded: true, id: openaiPath,
};

const svc = require('./topicCanonicalizationService');

test('canonicalize: returns LLM canonical slug on confident match', async () => {
  mockOpenAICreate = async () => ({
    choices: [{ message: { content: JSON.stringify({ canonicalTopic: 'product-manager', confidence: 0.93 }) } }],
  });
  svc._internal.clearCache();
  const r = await svc.canonicalize('Senior PM at FAANG', 'interview_preparation');
  assert.equal(r.canonicalTopic, 'product-manager');
  assert.equal(r.source, 'llm');
  assert.ok(r.confidence >= 0.9);
});

test('canonicalize: cache hit on identical input', async () => {
  let calls = 0;
  mockOpenAICreate = async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify({ canonicalTopic: 'gmat', confidence: 0.95 }) } }] };
  };
  svc._internal.clearCache();
  await svc.canonicalize('GMAT 720', 'exam_preparation');
  await svc.canonicalize('GMAT 720', 'exam_preparation');
  assert.equal(calls, 1, 'LLM should have been called exactly once for cached input');
});

test('canonicalize: invalid LLM slug falls back to general-learning', async () => {
  mockOpenAICreate = async () => ({
    choices: [{ message: { content: JSON.stringify({ canonicalTopic: 'made-up-slug-that-is-not-in-taxonomy', confidence: 0.9 }) } }],
  });
  svc._internal.clearCache();
  const r = await svc.canonicalize('Niche thing', 'upskilling');
  assert.equal(r.canonicalTopic, 'general-learning');
  assert.equal(r.source, 'llm-coerced');
});

test('canonicalize: LLM throws → fallback to normalizeTopic of raw text', async () => {
  mockOpenAICreate = async () => { throw new Error('openai down'); };
  svc._internal.clearCache();
  const r = await svc.canonicalize('  My Custom Topic  ', 'upskilling');
  assert.equal(r.canonicalTopic, 'my custom topic');
  assert.equal(r.source, 'fallback');
});

test('canonicalize: empty input returns general-learning, no LLM call', async () => {
  let called = false;
  mockOpenAICreate = async () => { called = true; return { choices: [] }; };
  svc._internal.clearCache();
  const r = await svc.canonicalize('', 'upskilling');
  assert.equal(r.canonicalTopic, 'general-learning');
  assert.equal(called, false);
});
