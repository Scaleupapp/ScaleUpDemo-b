const test = require('node:test');
const assert = require('node:assert');

// Mock OpenAI
const openaiPath = require.resolve('../../config/openai');
require.cache[openaiPath] = {
  exports: {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({ questions: [
                { questionText: 'Q1?', options: [
                  { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
                  { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
                ], correctAnswer: 'A', rationale: 'r' },
              ] }),
            },
          }],
        }),
      },
    },
  },
  loaded: true, id: openaiPath,
};

// Mock validator
const validatorPath = require.resolve('./questionValidatorService');
require.cache[validatorPath] = {
  exports: {
    validateQuestion: async () => ({ score: 92, critique: 'good', issues: [], status: 'auto_verified' }),
    classifyScore: () => 'auto_verified',
  },
  loaded: true, id: validatorPath,
};

// Mock QuestionBank
const qbPath = require.resolve('../../models/DiagnosticQuestionBank');
const inserted = [];
require.cache[qbPath] = {
  exports: Object.assign(
    function FakeQB(data) { Object.assign(this, data); },
    {
      find: () => ({ lean: async () => [
        { questionText: 'Anchor', options: [
          { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
          { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
        ], correctAnswer: 'A' },
      ] }),
      insertMany: async (docs) => { inserted.push(...docs); return docs; },
    }
  ),
  loaded: true, id: qbPath,
};

delete require.cache[require.resolve('./realtimeQuestionGenerationService')];
const { generateOnDemand } = require('./realtimeQuestionGenerationService');

test('generateOnDemand: generates, validates, persists, returns questions', async () => {
  inserted.length = 0;
  const result = await generateOnDemand({
    topic: { canonicalName: 'product-strategy', name: 'Product Strategy', description: 'd', baseDifficulty: 'intermediate' },
    targetKey: 'upskilling::product-management',
    difficulty: 'medium',
    count: 1,
  });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(inserted.length, 1);
  assert.strictEqual(inserted[0].verificationStatus, 'auto_verified');
  assert.strictEqual(inserted[0].generationSource, 'llm_realtime');
});
