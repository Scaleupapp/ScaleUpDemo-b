const test = require('node:test');
const assert = require('node:assert');

const openaiPath = require.resolve('../../config/openai');
require.cache[openaiPath] = {
  exports: {
    audio: {
      transcriptions: {
        create: async () => ({ text: 'I would prioritise stakeholder alignment first because...' }),
      },
    },
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                structureScore: 75,
                specificityScore: 80,
                relevanceScore: 90,
                articulationScore: 70,
                overallScore: 78,
                feedback: 'Good structure, could be more specific with examples.',
              }),
            },
          }],
        }),
      },
    },
  },
  loaded: true, id: openaiPath,
};

delete require.cache[require.resolve('./voiceAnswerService')];
const { transcribeAudio, scoreVoiceAnswer, scoreToBand } = require('./voiceAnswerService');

test('scoreToBand: maps 0-100 to bands', () => {
  assert.strictEqual(scoreToBand(15), 'novice');
  assert.strictEqual(scoreToBand(40), 'familiar');
  assert.strictEqual(scoreToBand(70), 'proficient');
  assert.strictEqual(scoreToBand(85), 'expert');
});

test('transcribeAudio: returns text from Whisper', async () => {
  const result = await transcribeAudio({ audioUrl: 'https://example.com/audio.m4a' });
  assert.match(result.text, /stakeholder alignment/);
});

test('scoreVoiceAnswer: returns structured rubric scores + band', async () => {
  const result = await scoreVoiceAnswer({
    transcription: 'I would prioritise stakeholder alignment...',
    questionText: 'How would you handle a misaligned cross-functional team?',
    canonicalCompetency: 'cross-functional-leadership',
  });
  assert.strictEqual(result.overallScore, 78);
  assert.strictEqual(result.band, 'proficient');
  assert.ok(result.feedback);
});
