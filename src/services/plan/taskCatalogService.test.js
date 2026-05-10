const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

delete require.cache[require.resolve('../../models/Quiz')];
const Quiz = require('../../models/Quiz');
delete require.cache[require.resolve('../../models/Content')];
const Content = require('../../models/Content');
delete require.cache[require.resolve('./taskCatalogService')];
const taskCatalogService = require('./taskCatalogService');

function makeQuery(value) {
  return { sort: () => ({ lean: async () => value }) };
}

test('resolveTopic: finds quiz scoped to objective first', async () => {
  const objectiveId = new mongoose.Types.ObjectId();
  const expectedQuiz = { _id: new mongoose.Types.ObjectId(), topic: 'product-strategy', estimatedMinutes: 10 };
  const calls = [];
  const origQuiz = Quiz.findOne;
  Quiz.findOne = (filter) => { calls.push(filter); return makeQuery(expectedQuiz); };
  const origContent = Content.findOne;
  Content.findOne = () => makeQuery(null);

  try {
    const out = await taskCatalogService.resolveTopic({
      topicCanonicalName: 'Product Strategy',
      objectiveType: 'interview_preparation',
      objectiveId,
    });
    assert.strictEqual(out.quizId, String(expectedQuiz._id));
    assert.strictEqual(out.quizMinutes, 10);
    assert.deepStrictEqual(calls[0], { topic: 'product-strategy', objectiveId });
  } finally {
    Quiz.findOne = origQuiz;
    Content.findOne = origContent;
  }
});

test('resolveTopic: falls back to global quiz when no objective-scoped match', async () => {
  const expectedQuiz = { _id: new mongoose.Types.ObjectId(), topic: 'roadmapping' };
  let call = 0;
  const origQuiz = Quiz.findOne;
  Quiz.findOne = () => { call++; return makeQuery(call === 1 ? null : expectedQuiz); };
  const origContent = Content.findOne;
  Content.findOne = () => makeQuery(null);

  try {
    const out = await taskCatalogService.resolveTopic({
      topicCanonicalName: 'roadmapping',
      objectiveType: 'interview_preparation',
      objectiveId: new mongoose.Types.ObjectId(),
    });
    assert.strictEqual(out.quizId, String(expectedQuiz._id));
    assert.strictEqual(out.quizMinutes, 8);
    assert.strictEqual(call, 2);
  } finally {
    Quiz.findOne = origQuiz;
    Content.findOne = origContent;
  }
});

test('resolveTopic: returns content when found', async () => {
  const expectedContent = {
    _id: new mongoose.Types.ObjectId(),
    contentType: 'article',
    duration: 14,
    topics: ['product-strategy'],
  };
  const origQuiz = Quiz.findOne;
  Quiz.findOne = () => makeQuery(null);
  const origContent = Content.findOne;
  Content.findOne = (filter) => {
    assert.deepStrictEqual(filter, { topics: 'product-strategy', status: 'published' });
    return makeQuery(expectedContent);
  };

  try {
    const out = await taskCatalogService.resolveTopic({
      topicCanonicalName: 'product-strategy',
      objectiveType: 'interview_preparation',
      objectiveId: new mongoose.Types.ObjectId(),
    });
    assert.strictEqual(out.contentId, String(expectedContent._id));
    assert.strictEqual(out.contentType, 'article');
    assert.strictEqual(out.contentMinutes, 14);
  } finally {
    Quiz.findOne = origQuiz;
    Content.findOne = origContent;
  }
});

test('resolveTopic: returns nulls when neither quiz nor content found', async () => {
  const origQuiz = Quiz.findOne;
  Quiz.findOne = () => makeQuery(null);
  const origContent = Content.findOne;
  Content.findOne = () => makeQuery(null);

  try {
    const out = await taskCatalogService.resolveTopic({
      topicCanonicalName: 'unknown-topic',
      objectiveType: 'interview_preparation',
      objectiveId: new mongoose.Types.ObjectId(),
    });
    assert.strictEqual(out.quizId, null);
    assert.strictEqual(out.contentId, null);
  } finally {
    Quiz.findOne = origQuiz;
    Content.findOne = origContent;
  }
});

test('resolveTopic: empty topic returns nulls without DB call', async () => {
  let called = false;
  const origQuiz = Quiz.findOne;
  Quiz.findOne = () => { called = true; return makeQuery(null); };
  const origContent = Content.findOne;
  Content.findOne = () => { called = true; return makeQuery(null); };

  try {
    const out = await taskCatalogService.resolveTopic({
      topicCanonicalName: '',
      objectiveType: 'interview_preparation',
      objectiveId: new mongoose.Types.ObjectId(),
    });
    assert.strictEqual(out.quizId, null);
    assert.strictEqual(out.contentId, null);
    assert.strictEqual(called, false);
  } finally {
    Quiz.findOne = origQuiz;
    Content.findOne = origContent;
  }
});
