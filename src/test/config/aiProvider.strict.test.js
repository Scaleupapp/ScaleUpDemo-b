'use strict';
/**
 * Block 3 (Wave 2) — aiProvider strict JSON extraction.
 *
 * analyzeWithClaude/evaluateWithClaude must THROW on unparseable JSON by
 * default (grading callers must never persist a `{ text }` fallback as an
 * evaluation), with `{ lenient: true }` restoring the legacy behaviour for
 * callers that tolerate prose.
 *
 * The Anthropic client is stubbed via Module._load — no network.
 */
const test = require('node:test');
const assert = require('node:assert');

const Module = require('module');
const originalLoad = Module._load;

let nextResponseText = '';

const anthropicStub = {
  messages: {
    create: async () => ({
      content: [{ type: 'text', text: nextResponseText }],
    }),
  },
};

const stubs = {
  './anthropic': anthropicStub,
  './openai': { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } } },
};

Module._load = function (request, parent) {
  if (parent && parent.filename && parent.filename.endsWith('config/aiProvider.js') && stubs[request]) {
    return stubs[request];
  }
  return originalLoad.apply(this, arguments);
};

// Fresh copy with stubs in place.
const aiProviderPath = require.resolve('../../config/aiProvider');
delete require.cache[aiProviderPath];
const aiProvider = require('../../config/aiProvider');

Module._load = originalLoad;

test.after(() => { delete require.cache[aiProviderPath]; });

test('analyzeWithClaude: parses valid JSON', async () => {
  nextResponseText = 'Here you go: {"score": 7, "notes": "ok"}';
  const r = await aiProvider.analyzeWithClaude({ systemPrompt: 's', userPrompt: 'u' });
  assert.deepStrictEqual(r, { score: 7, notes: 'ok' });
});

test('analyzeWithClaude: THROWS on prose with no JSON (default strict)', async () => {
  nextResponseText = 'I cannot produce JSON for that request.';
  await assert.rejects(
    () => aiProvider.analyzeWithClaude({ systemPrompt: 's', userPrompt: 'u' }),
    /no JSON object/
  );
});

test('analyzeWithClaude: THROWS on malformed JSON (default strict)', async () => {
  nextResponseText = '{"score": 7, "notes": "unterminated}';
  await assert.rejects(
    () => aiProvider.analyzeWithClaude({ systemPrompt: 's', userPrompt: 'u' }),
    /not valid JSON/
  );
});

test('analyzeWithClaude: lenient:true returns {text} on prose (legacy behaviour)', async () => {
  nextResponseText = 'Just some prose.';
  const r = await aiProvider.analyzeWithClaude({ systemPrompt: 's', userPrompt: 'u', lenient: true });
  assert.deepStrictEqual(r, { text: 'Just some prose.' });
});

test('analyzeWithClaude: lenient:true returns {text} on malformed JSON', async () => {
  nextResponseText = '{"broken": ';
  // No {...} match at all here (unbalanced) → no-JSON path; also cover the
  // parse-failure path with a matching-but-invalid object.
  const r1 = await aiProvider.analyzeWithClaude({ systemPrompt: 's', userPrompt: 'u', lenient: true });
  assert.strictEqual(typeof r1.text, 'string');
  nextResponseText = '{"a": nope}';
  const r2 = await aiProvider.analyzeWithClaude({ systemPrompt: 's', userPrompt: 'u', lenient: true });
  assert.strictEqual(r2.text, '{"a": nope}');
});

test('evaluateWithClaude: strict by default, forwards lenient', async () => {
  nextResponseText = 'no json here';
  await assert.rejects(() => aiProvider.evaluateWithClaude({ systemPrompt: 's', userPrompt: 'u' }));
  const r = await aiProvider.evaluateWithClaude({ systemPrompt: 's', userPrompt: 'u', lenient: true });
  assert.deepStrictEqual(r, { text: 'no json here' });
});
