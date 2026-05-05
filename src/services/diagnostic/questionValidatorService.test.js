const test = require('node:test');
const assert = require('node:assert');

const openaiPath = require.resolve('../../config/openai');
require.cache[openaiPath] = {
  exports: {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                score: 92,
                critique: 'Question is clear, single correct answer, India-context appropriate.',
                issues: [],
              }),
            },
          }],
        }),
      },
    },
  },
  loaded: true,
  id: openaiPath,
};

delete require.cache[require.resolve('./questionValidatorService')];
const { validateQuestion, classifyScore } = require('./questionValidatorService');

test('classifyScore: ≥90 returns auto_verified', () => {
  assert.strictEqual(classifyScore(95), 'auto_verified');
  assert.strictEqual(classifyScore(90), 'auto_verified');
});

test('classifyScore: 70-89 returns pending', () => {
  assert.strictEqual(classifyScore(85), 'pending');
  assert.strictEqual(classifyScore(70), 'pending');
});

test('classifyScore: <70 returns flagged_for_review', () => {
  assert.strictEqual(classifyScore(69), 'flagged_for_review');
  assert.strictEqual(classifyScore(0), 'flagged_for_review');
});

test('validateQuestion: returns score + critique + status from LLM', async () => {
  const question = {
    questionText: 'What is product-market fit?',
    options: [
      { label: 'A', text: 'A perfect product' },
      { label: 'B', text: 'When customers pull product from you' },
      { label: 'C', text: 'High revenue' },
      { label: 'D', text: 'Good marketing' },
    ],
    correctAnswer: 'B',
    difficulty: 'easy',
    canonicalCompetency: 'product-strategy',
  };
  const result = await validateQuestion(question);
  assert.strictEqual(result.score, 92);
  assert.strictEqual(result.status, 'auto_verified');
  assert.ok(result.critique.length > 0);
  assert.deepStrictEqual(result.issues, []);
});

test('validateQuestion: handles malformed LLM response gracefully', async () => {
  const openaiPath = require.resolve('../../config/openai');
  require.cache[openaiPath] = {
    exports: {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'not valid json' } }],
          }),
        },
      },
    },
    loaded: true, id: openaiPath,
  };
  delete require.cache[require.resolve('./questionValidatorService')];
  const { validateQuestion } = require('./questionValidatorService');
  const result = await validateQuestion({
    questionText: 'q',
    options: [
      { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
      { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
    ],
    correctAnswer: 'A',
    difficulty: 'easy',
    canonicalCompetency: 'x',
  });
  assert.strictEqual(result.status, 'flagged_for_review');
  assert.strictEqual(result.score, 0);
  assert.ok(result.critique.includes('parse'));
});

test('validateQuestion: retries on 429 then succeeds', async () => {
  let calls = 0;
  const openaiPath = require.resolve('../../config/openai');
  require.cache[openaiPath] = {
    exports: {
      chat: {
        completions: {
          create: async () => {
            calls++;
            if (calls < 2) { const e = new Error('rate limit'); e.status = 429; throw e; }
            return { choices: [{ message: { content: JSON.stringify({ score: 90, critique: 'ok', issues: [] }) } }] };
          },
        },
      },
    },
    loaded: true, id: openaiPath,
  };
  delete require.cache[require.resolve('./questionValidatorService')];
  const { validateQuestion } = require('./questionValidatorService');
  const result = await validateQuestion({
    questionText: 'q',
    options: [
      { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
      { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
    ],
    correctAnswer: 'A',
    difficulty: 'easy',
    canonicalCompetency: 'x',
  });
  assert.strictEqual(result.status, 'auto_verified');
  assert.ok(calls >= 2, `expected at least 2 calls (1 initial + 1 retry), got ${calls}`);
});
