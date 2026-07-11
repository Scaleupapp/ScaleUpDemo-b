'use strict';
/**
 * Gate-1 lint in the SHARED generateQuiz path (D2C coverage).
 *
 * Proves malformed/duplicate items produced by the generator are dropped and
 * refilled via the existing top-up loop — with no API/response-shape change.
 * All heavy deps (Redis queue, OpenAI, Mongoose models) are stubbed via
 * require.cache BEFORE requiring the service (same pattern as
 * diagnosticCounterFix.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');

// ── Stub heavy modules before requiring quizGenerationService ─────────────────
function stub(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { exports, loaded: true, id: resolved };
}

// Sequenced OpenAI stub: each call returns the next scripted payload.
let openaiCalls = [];
let openaiScript = [];
let lastSystemPrompt = null;
function scriptOpenAI(payloads) { openaiScript = payloads; openaiCalls = []; lastSystemPrompt = null; }
stub('../config/openai', {
  chat: {
    completions: {
      create: async ({ messages }) => {
        const idx = openaiCalls.length;
        openaiCalls.push(idx);
        lastSystemPrompt = (messages && messages[0] && messages[0].content) || null;
        const questions = openaiScript[Math.min(idx, openaiScript.length - 1)];
        return { choices: [{ message: { content: JSON.stringify({ questions }) } }] };
      },
    },
  },
});
stub('../config/queue', { notificationQueue: { add: async () => ({}) } });
stub('../models/Content', { find: async () => [] });
stub('../models/QuizTrigger', { findByIdAndUpdate: async () => ({}) });
stub('../models/KnowledgeProfile', { findOne: async () => null });
stub('../models/UserObjective', { findOne: async () => null, findById: async () => null });

let createdQuiz = null;
stub('../models/Quiz', {
  create: async (doc) => { createdQuiz = { _id: 'quiz1', ...doc }; return createdQuiz; },
  find: () => ({ select: () => ({ limit: () => ({ lean: async () => [] }) }) }),
});
const emptyChain = { sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }) };
stub('../models/QuizAttempt', { find: () => emptyChain });
stub('../models/ExternalContentTouch', { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
stub('../models/ExternalContentSnapshot', { find: () => ({ select: () => ({ lean: async () => [] }) }) });
stub('../services/userContextService', { getUserContext: async () => ({}), summarize: () => '' });

const quizGenerationService = require('../services/quizGenerationService');

function opt(l, t) { return { label: l, text: t }; }
function goodQ(stem, key = 'A') {
  return {
    questionText: stem,
    questionType: 'conceptual',
    options: [opt('A', 'Hash map'), opt('B', 'Sorted array'), opt('C', 'Linked list'), opt('D', 'Binary heap')],
    correctAnswer: key,
    explanation: 'because',
    difficulty: 'easy',
    concept: 'ds',
  };
}
function malformedDupOptions(stem) {
  return {
    questionText: stem,
    questionType: 'conceptual',
    options: [opt('A', 'Same'), opt('B', 'Same'), opt('C', 'Same'), opt('D', 'Same')],
    correctAnswer: 'A',
    explanation: 'x',
    difficulty: 'easy',
  };
}

test('generateQuiz drops a malformed item and tops up to the requested count', async () => {
  // Round 1 returns 1 good + 1 malformed (dup options) + 1 duplicate-stem of the good one.
  // Gate-1 keeps only the first good item → shortfall triggers the top-up loop.
  const dupStem = 'Which structure offers O(1) average lookup by key value in this case?';
  scriptOpenAI([
    [goodQ(dupStem, 'A'), malformedDupOptions('A totally different malformed question stem here?'), goodQ(dupStem, 'A')],
    [goodQ('What is the worst-case cost of a binary heap push operation exactly?', 'B'),
     goodQ('Describe the traversal cost of a singly linked list node chain fully.', 'C')],
  ]);

  const quiz = await quizGenerationService.generateQuiz({
    userId: 'u1',
    topic: 'data structures',
    questionCount: 3,
    isSkillAssessment: true,
    suppressNotification: true,
    noObjective: true,
  });

  assert.ok(quiz, 'quiz created');
  assert.strictEqual(quiz.questions.length, 3, 'topped up to 3 clean questions');
  assert.strictEqual(quiz.totalQuestions, 3);

  // No malformed (duplicate-option) item survived.
  for (const q of quiz.questions) {
    const texts = q.options.map((o) => o.text.toLowerCase());
    assert.strictEqual(new Set(texts).size, 4, 'every served question has 4 distinct options');
  }
  // The generator was called more than once (top-up happened).
  assert.ok(openaiCalls.length >= 2, 'top-up continuation call was made');
});

test('injectedCompetencies routes generation through the competency prompt and tags the quiz', async () => {
  const competencyQ = (stem) => ({ ...goodQ(stem, 'A'), competency: 'DSA' });
  scriptOpenAI([[
    competencyQ('Q about hashing buckets and collisions in this domain here?'),
    competencyQ('Q about balanced tree rotation invariants in this domain here?'),
  ]]);

  const quiz = await quizGenerationService.generateQuiz({
    userId: 'u1',
    topic: 'data structures',
    questionCount: 2,
    isSkillAssessment: true,
    suppressNotification: true,
    noObjective: true,
    injectedCompetencies: [{ name: 'DSA', category: 'core', weight: 5 }],
  });

  // Routed through the competency-based system prompt (which emits `competency`).
  assert.ok(lastSystemPrompt, 'a system prompt was sent');
  assert.match(lastSystemPrompt, /competency-based evaluation/i, 'competency prompt selected');
  // Quiz tagged with the injected competency; per-question competency preserved.
  assert.deepStrictEqual(quiz.linkedCompetencies, ['DSA']);
  assert.ok(quiz.questions.every((q) => q.competency === 'DSA'), 'each question keeps its competency tag');
});

test('groundingText is injected into the generation prompt (institution path)', async () => {
  scriptOpenAI([[
    goodQ('Q one about the syllabus material here?', 'A'),
    goodQ('Q two about the syllabus material here?', 'B'),
  ]]);
  let userPromptSeen = null;
  // Re-capture the user prompt for this assertion via a one-off wrapper.
  const origCreate = require('../config/openai').chat.completions.create;
  require('../config/openai').chat.completions.create = async (args) => {
    userPromptSeen = args.messages[1].content;
    return origCreate(args);
  };
  try {
    await quizGenerationService.generateQuiz({
      userId: 'u1', topic: 'data structures', questionCount: 2,
      isSkillAssessment: true, suppressNotification: true, noObjective: true,
      groundingText: 'UNIQUE_SYLLABUS_MARKER_XYZ about linked lists and trees.',
    });
  } finally {
    require('../config/openai').chat.completions.create = origCreate;
  }
  assert.match(userPromptSeen, /UNIQUE_SYLLABUS_MARKER_XYZ/, 'grounding text injected into the prompt');
});

test('generateQuiz is a pass-through when all items are clean (no extra calls)', async () => {
  scriptOpenAI([
    [goodQ('Q one about hashing buckets and collisions here?', 'A'),
     goodQ('Q two about balanced tree rotation invariants here?', 'B'),
     goodQ('Q three about heap sift-down ordering guarantees here?', 'C')],
  ]);

  const quiz = await quizGenerationService.generateQuiz({
    userId: 'u1',
    topic: 'data structures',
    questionCount: 3,
    isSkillAssessment: true,
    suppressNotification: true,
    noObjective: true,
  });

  assert.strictEqual(quiz.questions.length, 3);
  assert.strictEqual(openaiCalls.length, 1, 'no top-up needed when all items pass Gate-1');
});
