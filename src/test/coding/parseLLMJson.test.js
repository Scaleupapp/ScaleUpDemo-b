'use strict';

require('dotenv').config();
process.env.OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || 'stub';
process.env.ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || 'stub';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { parseLLMJson } = require('../../coding/services/drillGrader/parseLLMJson');

test('parseLLMJson — plain JSON in text block', () => {
  const content = [{ type: 'text', text: '{"a":1,"b":"hello"}' }];
  const result = parseLLMJson(content);
  assert.deepEqual(result, { a: 1, b: 'hello' });
});

test('parseLLMJson — JSON wrapped in ```json fences (the actual bug)', () => {
  const content = [{ type: 'text', text: '```json\n{"overall_score":78,"rubric":{}}\n```' }];
  const result = parseLLMJson(content);
  assert.equal(result.overall_score, 78);
});

test('parseLLMJson — JSON wrapped in plain ``` fences (no language tag)', () => {
  const content = [{ type: 'text', text: '```\n{"a":1}\n```' }];
  const result = parseLLMJson(content);
  assert.deepEqual(result, { a: 1 });
});

test('parseLLMJson — fences with surrounding prose (LLM commentary)', () => {
  const text = 'Here is the grade:\n\n```json\n{"overall_score":42}\n```\n\nHope this helps!';
  const result = parseLLMJson([{ type: 'text', text }]);
  assert.equal(result.overall_score, 42);
});

test('parseLLMJson — empty content array throws', () => {
  assert.throws(() => parseLLMJson([]), /empty/i);
});

test('parseLLMJson — non-array content throws', () => {
  assert.throws(() => parseLLMJson('not an array'), /not an array/i);
});

test('parseLLMJson — content with no text block throws', () => {
  const content = [{ type: 'tool_use', input: {} }];
  assert.throws(() => parseLLMJson(content), /no text block/i);
});

test('parseLLMJson — invalid JSON surfaces a useful error with snippet', () => {
  const content = [{ type: 'text', text: 'this is not json' }];
  assert.throws(() => parseLLMJson(content), /not valid JSON/i);
});

test('parseLLMJson — empty text after fence stripping throws', () => {
  const content = [{ type: 'text', text: '```json\n\n```' }];
  assert.throws(() => parseLLMJson(content), /empty after fence/i);
});
