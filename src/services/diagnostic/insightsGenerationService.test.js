const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SERVICE_PATH = require.resolve('./insightsGenerationService');
const OPENAI_PATH = require.resolve('../../config/openai');

function installOpenAIStub(stub) {
  require.cache[OPENAI_PATH] = {
    exports: stub,
    loaded: true,
    id: OPENAI_PATH,
  };
  delete require.cache[SERVICE_PATH];
  return require('./insightsGenerationService');
}

const baseInput = {
  objectiveType: 'upskilling',
  specificsCanonical: 'product-management',
  timelineWeeks: 12,
  weeklyCommitHours: 6,
  companyProfile: null,
  topics: [
    { canonicalName: 'product-strategy', name: 'Product Strategy', selfRating: 'Proficient', measuredScore: 70,
      questionsAsked: 4, missedDifficulties: ['hard'] },
    { canonicalName: 'user-research',    name: 'User Research',    selfRating: 'Familiar',   measuredScore: 35,
      questionsAsked: 4, missedDifficulties: ['medium', 'hard'] },
    { canonicalName: 'stakeholder-mgmt', name: 'Stakeholder Mgmt', selfRating: 'Expert',     measuredScore: 30,
      questionsAsked: 4, missedDifficulties: ['easy', 'medium', 'hard'] },
  ],
};

const validLLMResponse = {
  hero: 'You ship like a Proficient PM but underestimate yourself on User Research.',
  calibration: 'Well-calibrated on 1 of 3 topics — biggest blind spot is Stakeholder Mgmt.',
  patterns: [
    'You overrate skills you use daily, underrate skills you reach for occasionally.',
    'You miss the hardest difficulty consistently across topics — fixable with deliberate practice.',
  ],
  topicTakeaways: {
    'product-strategy': 'On track — push into harder strategy bets.',
    'user-research': 'Stronger than you think — own it.',
    'stakeholder-mgmt': 'Biggest gap — focus the first 3 weeks here.',
  },
  planHeadline: 'Over 12 weeks at 6 hrs/week we will close the Stakeholder Mgmt gap, harden Strategy, and validate User Research instincts with two milestone reviews.',
};

test('insightsGenerationService: returns LLM JSON when call succeeds', async () => {
  const svc = installOpenAIStub({
    chat: { completions: {
      create: async () => ({ choices: [{ message: { content: JSON.stringify(validLLMResponse) } }] }),
    } },
  });
  const out = await svc.generateInsights(baseInput);
  assert.strictEqual(out.source, 'llm');
  assert.strictEqual(out.insights.hero, validLLMResponse.hero);
  assert.deepStrictEqual(out.insights.patterns, validLLMResponse.patterns);
  assert.strictEqual(out.insights.topicTakeaways['stakeholder-mgmt'], validLLMResponse.topicTakeaways['stakeholder-mgmt']);
});

test('insightsGenerationService: falls back when LLM throws', async () => {
  const svc = installOpenAIStub({
    chat: { completions: { create: async () => { throw new Error('rate_limited'); } } },
  });
  const out = await svc.generateInsights(baseInput);
  assert.strictEqual(out.source, 'template');
  assert.strictEqual(out.fallbackReason, 'error');
  assert.ok(out.insights.hero && out.insights.hero.length > 0);
  assert.ok(out.insights.calibration && out.insights.calibration.length > 0);
  assert.ok(Array.isArray(out.insights.patterns) && out.insights.patterns.length >= 1);
  for (const t of baseInput.topics) {
    assert.ok(out.insights.topicTakeaways[t.canonicalName], 'missing takeaway for ' + t.canonicalName);
  }
  assert.ok(out.insights.planHeadline && out.insights.planHeadline.length > 0);
});

test('insightsGenerationService: falls back when LLM returns malformed JSON', async () => {
  const svc = installOpenAIStub({
    chat: { completions: { create: async () => ({ choices: [{ message: { content: 'not json' } }] }) } },
  });
  const out = await svc.generateInsights(baseInput);
  assert.strictEqual(out.source, 'template');
  assert.strictEqual(out.fallbackReason, 'parse_error');
});

test('insightsGenerationService: falls back when LLM omits required keys', async () => {
  const svc = installOpenAIStub({
    chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ hero: 'short' }) } }] }) } },
  });
  const out = await svc.generateInsights(baseInput);
  assert.strictEqual(out.source, 'template');
  assert.strictEqual(out.fallbackReason, 'schema_error');
});

test('insightsGenerationService: respects timeoutMs', async () => {
  const svc = installOpenAIStub({
    chat: { completions: {
      create: () => new Promise(resolve => setTimeout(() => resolve({
        choices: [{ message: { content: JSON.stringify(validLLMResponse) } }],
      }), 200)),
    } },
  });
  const t0 = Date.now();
  const out = await svc.generateInsights(baseInput, { timeoutMs: 50 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 180, 'should resolve via timeout, not wait full LLM duration');
  assert.strictEqual(out.source, 'template');
  assert.strictEqual(out.fallbackReason, 'timeout');
});

test('insightsGenerationService: template fallback covers overestimate-dominant attempts', () => {
  const svc = require('./insightsGenerationService');
  const insights = svc._templateInsights(baseInput);
  assert.match(insights.hero.toLowerCase(), /stakeholder/);
  assert.match(insights.calibration.toLowerCase(), /calibrated|blind spot|overrate|underrate/);
});
