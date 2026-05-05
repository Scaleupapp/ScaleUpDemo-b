const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SERVICE_PATH = path.resolve(__dirname, './specificsNormalizationService.js');

function loadServiceWith(mockOpenAI) {
  delete require.cache[SERVICE_PATH];
  // Mock the openai module the service requires.
  const openaiModulePath = require.resolve('openai');
  delete require.cache[openaiModulePath];
  require.cache[openaiModulePath] = {
    id: openaiModulePath,
    filename: openaiModulePath,
    loaded: true,
    exports: mockOpenAI,
  };
  return require(SERVICE_PATH);
}

const makeOpenAIMock = (impl) => {
  function MockOpenAI() {
    this.chat = { completions: { create: impl } };
  }
  return { OpenAI: MockOpenAI, default: MockOpenAI };
};

test('normalizeSpecifics: returns canonical fields from LLM response', async () => {
  const mock = makeOpenAIMock(async () => ({
    choices: [{
      message: {
        content: JSON.stringify({
          examName: 'JEE Advanced',
          targetCompany: 'Google',
        }),
      },
    }],
  }));
  const svc = loadServiceWith(mock);
  const out = await svc.normalizeSpecifics({
    objectiveType: 'exam_preparation',
    specifics: { examName: 'jee', targetCompany: 'goog' },
  });
  assert.strictEqual(out.examName, 'JEE Advanced');
  assert.strictEqual(out.targetCompany, 'Google');
});

test('normalizeSpecifics: returns raw input when LLM throws', async () => {
  const mock = makeOpenAIMock(async () => { throw new Error('boom'); });
  const svc = loadServiceWith(mock);
  const raw = { examName: 'jee', targetCompany: 'goog' };
  const out = await svc.normalizeSpecifics({
    objectiveType: 'exam_preparation',
    specifics: raw,
  });
  assert.deepStrictEqual(out, raw);
});

test('normalizeSpecifics: returns raw input when LLM returns invalid JSON', async () => {
  const mock = makeOpenAIMock(async () => ({
    choices: [{ message: { content: 'not json {{' } }],
  }));
  const svc = loadServiceWith(mock);
  const raw = { targetSkill: 'sys design' };
  const out = await svc.normalizeSpecifics({
    objectiveType: 'upskilling',
    specifics: raw,
  });
  assert.deepStrictEqual(out, raw);
});

test('normalizeSpecifics: returns empty object when input has no fields', async () => {
  const mock = makeOpenAIMock(async () => {
    throw new Error('should not be called');
  });
  const svc = loadServiceWith(mock);
  const out = await svc.normalizeSpecifics({
    objectiveType: 'casual_learning',
    specifics: {},
  });
  assert.deepStrictEqual(out, {});
});

test('normalizeSpecifics: returns raw input when LLM exceeds 3s timeout', async () => {
  const mock = makeOpenAIMock(async (_args, opts) => {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ choices: [{ message: { content: '{}' } }] }), 5000);
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          clearTimeout(t);
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  });
  const svc = loadServiceWith(mock);
  const raw = { examName: 'cat' };
  const out = await svc.normalizeSpecifics({
    objectiveType: 'exam_preparation',
    specifics: raw,
  });
  assert.deepStrictEqual(out, raw);
});
