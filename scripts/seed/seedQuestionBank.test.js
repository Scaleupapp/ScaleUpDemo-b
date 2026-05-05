const test = require('node:test');
const assert = require('node:assert');

const openaiPath = require.resolve('../../src/config/openai');
require.cache[openaiPath] = {
  exports: {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                questions: [
                  {
                    questionText: 'Q1?',
                    options: [
                      { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
                      { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
                    ],
                    correctAnswer: 'A',
                    rationale: 'r',
                  },
                  {
                    questionText: 'Q2?',
                    options: [
                      { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
                      { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
                    ],
                    correctAnswer: 'B',
                    rationale: 'r',
                  },
                ],
              }),
            },
          }],
        }),
      },
    },
  },
  loaded: true, id: openaiPath,
};

const validatorPath = require.resolve('../../src/services/diagnostic/questionValidatorService');
require.cache[validatorPath] = {
  exports: {
    validateQuestion: async () => ({ score: 92, critique: 'good', issues: [], status: 'auto_verified' }),
    classifyScore: () => 'auto_verified',
  },
  loaded: true, id: validatorPath,
};

delete require.cache[require.resolve('./seedQuestionBank')];
const { generateBatch } = require('./seedQuestionBank');

test('generateBatch: returns validated questions tagged with status', async () => {
  const topic = {
    canonicalName: 'product-strategy',
    name: 'Product Strategy',
    description: 'Defining product vision.',
    baseDifficulty: 'intermediate',
  };
  const anchors = [
    { questionText: 'AnchorQ1', options: [
      { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
      { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
    ], correctAnswer: 'A', rationale: 'r' },
  ];
  const questions = await generateBatch(topic, 'upskilling::product-management', 'medium', anchors, 4);
  assert.strictEqual(questions.length, 2);
  for (const q of questions) {
    assert.strictEqual(q.verificationStatus, 'auto_verified');
    assert.strictEqual(q.validatorScore, 92);
    assert.strictEqual(q.canonicalCompetency, 'product-strategy');
    assert.strictEqual(q.difficulty, 'medium');
    assert.strictEqual(q.isAnchor, false);
    assert.strictEqual(q.generationSource, 'seed_batch');
  }
});
