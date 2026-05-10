const test = require('node:test');
const assert = require('node:assert');

// Pre-stub openai config so the module loads without a real OPENAI_API_KEY.
// Individual LLM tests override this stub as needed.
{
  const openaiPath = require.resolve('../../config/openai');
  if (!require.cache[openaiPath]) {
    require.cache[openaiPath] = {
      exports: { chat: { completions: { create: async () => ({ choices: [] }) } } },
      loaded: true, id: openaiPath,
    };
  }
}

delete require.cache[require.resolve('./externalContentJudgeService')];
const judgeService = require('./externalContentJudgeService');

const openai = require('../../config/openai');

function withStubbedLLM(returnValue, fn) {
  const orig = openai.chat.completions.create;
  openai.chat.completions.create = async () => ({
    choices: [{ message: { content: JSON.stringify(returnValue) } }],
  });
  return fn().finally(() => { openai.chat.completions.create = orig; });
}

test('judgeTopic: returns adequate=true with empty links when LLM says coverage is fine', async () => {
  await withStubbedLLM(
    { inAppCoverageAdequate: true, gaps: [], externalLinks: [] },
    async () => {
      const out = await judgeService.judgeTopic({
        objectiveType: 'upskilling',
        targetKey: 'upskilling::react',
        topic: 'react-hooks',
        measuredBand: 'developing',
        inAppContent: [{ title: 'React Hooks Quiz', type: 'quiz' }],
      });
      assert.strictEqual(out.inAppCoverageAdequate, true);
      assert.deepStrictEqual(out.externalLinks, []);
    },
  );
});

test('judgeTopic: filters out external links not on the whitelist', async () => {
  await withStubbedLLM(
    {
      inAppCoverageAdequate: false,
      gaps: ['advanced patterns missing'],
      externalLinks: [
        { url: 'https://ocw.mit.edu/courses/foo', title: 'MIT OCW Foo', source: 'mit', why: 'reason', estimatedMinutes: 30 },
        { url: 'https://random-spam-blog.io/foo', title: 'Spam', source: 'spam', why: 'r', estimatedMinutes: 10 },
        { url: 'not-a-url', title: 'broken', source: 'x', why: 'r', estimatedMinutes: 5 },
      ],
    },
    async () => {
      const out = await judgeService.judgeTopic({
        objectiveType: 'upskilling',
        targetKey: 'upskilling::react',
        topic: 'react-hooks',
        measuredBand: 'developing',
        inAppContent: [],
      });
      assert.strictEqual(out.inAppCoverageAdequate, false);
      assert.strictEqual(out.externalLinks.length, 1, 'only the MIT link should survive');
      assert.strictEqual(out.externalLinks[0].url, 'https://ocw.mit.edu/courses/foo');
    },
  );
});

test('judgeTopic: caps externalLinks at 3 even if LLM returns more', async () => {
  await withStubbedLLM(
    {
      inAppCoverageAdequate: false,
      gaps: ['gap'],
      externalLinks: Array.from({ length: 5 }, (_, i) => ({
        url: `https://ocw.mit.edu/courses/${i}`,
        title: `MIT ${i}`,
        source: 'mit',
        why: 'r',
        estimatedMinutes: 20,
      })),
    },
    async () => {
      const out = await judgeService.judgeTopic({
        objectiveType: 'upskilling',
        targetKey: 'k',
        topic: 'react-hooks',
        measuredBand: 'developing',
        inAppContent: [],
      });
      assert.strictEqual(out.externalLinks.length, 3);
    },
  );
});

test('judgeTopic: returns safe default on LLM failure', async () => {
  const orig = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('LLM down'); };
  try {
    const out = await judgeService.judgeTopic({
      objectiveType: 'upskilling',
      targetKey: 'k',
      topic: 'react-hooks',
      measuredBand: 'developing',
      inAppContent: [],
    });
    assert.strictEqual(out.inAppCoverageAdequate, true, 'failure mode = treat as adequate (no spam)');
    assert.deepStrictEqual(out.externalLinks, []);
  } finally {
    openai.chat.completions.create = orig;
  }
});
