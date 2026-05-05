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
                    questionText: 'Which framework helps prioritise features?',
                    options: [
                      { label: 'A', text: 'RICE' },
                      { label: 'B', text: 'SOLID' },
                      { label: 'C', text: 'STAR' },
                      { label: 'D', text: 'MEDDIC' },
                    ],
                    correctAnswer: 'A',
                    rationale: 'RICE = Reach × Impact × Confidence ÷ Effort',
                  },
                  {
                    questionText: 'PM at Razorpay must decide between two features. Best first step?',
                    options: [
                      { label: 'A', text: 'Ship both' },
                      { label: 'B', text: 'Define success metrics for each' },
                      { label: 'C', text: 'Ask CEO' },
                      { label: 'D', text: 'A/B test in prod' },
                    ],
                    correctAnswer: 'B',
                    rationale: 'Without metrics no decision can be evaluated.',
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

const qbPath = require.resolve('../../src/models/DiagnosticQuestionBank');
const writes = [];
require.cache[qbPath] = {
  exports: Object.assign(
    function FakeQB(data) { Object.assign(this, data); this.save = async () => { writes.push({ ...this }); return this; }; },
    { insertMany: async (docs) => { writes.push(...docs); return docs; } }
  ),
  loaded: true, id: qbPath,
};

delete require.cache[require.resolve('./seedAnchorQuestions')];
const { generateAnchorsForTopic } = require('./seedAnchorQuestions');

test('generateAnchorsForTopic: returns parsed questions tagged isAnchor', async () => {
  writes.length = 0;
  const topic = {
    canonicalName: 'product-strategy',
    name: 'Product Strategy',
    description: 'Defining product vision and prioritising bets.',
    baseDifficulty: 'intermediate',
  };
  const anchors = await generateAnchorsForTopic(topic, 'upskilling::product-management');
  assert.strictEqual(anchors.length, 2);
  for (const q of anchors) {
    assert.strictEqual(q.isAnchor, true);
    assert.strictEqual(q.canonicalCompetency, 'product-strategy');
    assert.strictEqual(q.generationSource, 'seed_batch');
    assert.ok(q.questionText);
    assert.strictEqual(q.options.length, 4);
  }
});
