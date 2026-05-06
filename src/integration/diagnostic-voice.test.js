const test = require('node:test');
const assert = require('node:assert');

const openaiPath = require.resolve('../config/openai');
require.cache[openaiPath] = {
  exports: { chat: { completions: { create: async () => ({}) } } },
  loaded: true, id: openaiPath,
};

// Stub diagnosticService to avoid pulling in queues/redis/mongoose at require-time.
const dsPath = require.resolve('../services/diagnosticService');
require.cache[dsPath] = { exports: {}, loaded: true, id: dsPath };

const vasPath = require.resolve('../services/diagnostic/voiceAnswerService');
require.cache[vasPath] = {
  exports: {
    processVoiceAnswer: async () => ({
      success: true,
      transcription: 'Test transcription',
      overallScore: 78,
      band: 'proficient',
      feedback: 'Good answer.',
    }),
  },
  loaded: true, id: vasPath,
};

const uploadPath = require.resolve('../services/uploadService');
require.cache[uploadPath] = {
  exports: {
    uploadAudioBuffer: async (buffer) => ({ s3Key: 'voice/test.m4a', url: 'https://s3.example/voice/test.m4a' }),
  },
  loaded: true, id: uploadPath,
};

delete require.cache[require.resolve('../controllers/diagnosticController')];
const controller = require('../controllers/diagnosticController');

test('POST /diagnostic/voice/upload: handler returns transcription + score', async () => {
  const req = {
    body: { questionText: 'Behavioral Q?', canonicalCompetency: 'behavioral' },
    file: { buffer: Buffer.from('fake audio') },
  };
  let captured;
  const res = {
    status(code) { this.code = code; return this; },
    json(payload) { captured = payload; return this; },
  };
  await controller.uploadVoiceAnswer(req, res);
  assert.strictEqual(captured.success, true);
  assert.strictEqual(captured.transcription, 'Test transcription');
  assert.strictEqual(captured.band, 'proficient');
  assert.ok(captured.audioUrl);
});
