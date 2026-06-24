'use strict';
/**
 * Unit tests for D2C exclusion of institution-cloned quizzes (Sub-feature F / M8).
 *
 * Verifies that listQuizzes, getSkillAssessments, and getPendingQuizzes all
 * pass `source: { $ne: 'institution_assessment' }` to Quiz.find.
 *
 * No real DB — Quiz.find is monkey-patched per test.
 */

// Must be set before any require that pulls in openai/anthropic clients
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub-for-tests';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert');

// Import the controller functions
const quizController = require('../controllers/quizController');
const Quiz = require('../models/Quiz');

// Helper: make a mock req/res pair
function makeReqRes(userId = 'u1') {
  const req = { user: { userId } };
  let sentJson = null;
  const res = {
    json: (data) => { sentJson = data; },
    status: () => res, // chainable
    _getSent: () => sentJson,
  };
  return { req, res };
}

// ---------------------------------------------------------------------------
// listQuizzes — source: { $ne: 'institution_assessment' }
// ---------------------------------------------------------------------------

test('listQuizzes excludes quizzes with source=institution_assessment', async () => {
  let capturedQuery = null;

  // Monkey-patch Quiz.find for this test only
  const originalFind = Quiz.find.bind(Quiz);
  Quiz.find = (query) => {
    capturedQuery = query;
    return {
      sort: () => ({ select: () => Promise.resolve([]) }),
    };
  };

  try {
    const { req, res } = makeReqRes();
    await quizController.listQuizzes(req, res, (err) => { throw err; });

    assert.ok(capturedQuery, 'Quiz.find should have been called');
    assert.deepStrictEqual(
      capturedQuery.source,
      { $ne: 'institution_assessment' },
      'listQuizzes should exclude institution_assessment source'
    );
  } finally {
    // Restore
    Quiz.find = originalFind;
  }
});

// ---------------------------------------------------------------------------
// getSkillAssessments — source: { $ne: 'institution_assessment' }
// ---------------------------------------------------------------------------

test('getSkillAssessments excludes quizzes with source=institution_assessment', async () => {
  let capturedQuery = null;

  const originalFind = Quiz.find.bind(Quiz);
  Quiz.find = (query) => {
    capturedQuery = query;
    return {
      sort: () => ({ select: () => Promise.resolve([]) }),
    };
  };

  try {
    const { req, res } = makeReqRes();
    await quizController.getSkillAssessments(req, res, (err) => { throw err; });

    assert.ok(capturedQuery, 'Quiz.find should have been called');
    assert.deepStrictEqual(
      capturedQuery.source,
      { $ne: 'institution_assessment' },
      'getSkillAssessments should exclude institution_assessment source'
    );
  } finally {
    Quiz.find = originalFind;
  }
});

// ---------------------------------------------------------------------------
// getPendingQuizzes — source: { $ne: 'institution_assessment' }
// ---------------------------------------------------------------------------

test('getPendingQuizzes excludes quizzes with source=institution_assessment', async () => {
  let capturedQuery = null;

  // getPendingQuizzes also calls UserObjective.findOne — stub it
  const UserObjective = require('../models/UserObjective');
  const originalFindOne = UserObjective.findOne.bind(UserObjective);
  UserObjective.findOne = () => Promise.resolve(null); // no active objective

  const originalFind = Quiz.find.bind(Quiz);
  Quiz.find = (query) => {
    capturedQuery = query;
    return {
      sort: () => ({ select: () => Promise.resolve([]) }),
    };
  };

  try {
    const { req, res } = makeReqRes();
    await quizController.getPendingQuizzes(req, res, (err) => { throw err; });

    assert.ok(capturedQuery, 'Quiz.find should have been called');
    assert.deepStrictEqual(
      capturedQuery.source,
      { $ne: 'institution_assessment' },
      'getPendingQuizzes should exclude institution_assessment source'
    );
  } finally {
    Quiz.find = originalFind;
    UserObjective.findOne = originalFindOne;
  }
});

// ---------------------------------------------------------------------------
// getHistory — excludes attempts whose quiz has source='institution_assessment'
// ---------------------------------------------------------------------------

const QuizAttempt = require('../models/QuizAttempt');

test('getHistory excludes attempts whose quiz has source=institution_assessment', async () => {
  // Arrange: user has 2 quizzes — one normal D2C, one institution clone
  const cloneQuizId = { _id: 'clone-quiz-id', toString: () => 'clone-quiz-id' };
  const normalQuizId = 'normal-quiz-id';

  // The institution clone quiz ids returned by Quiz.find(..., source:institution_assessment)
  const cloneQuizDocs = [{ _id: cloneQuizId }];

  // QuizAttempts for the user (both clone and normal)
  const allAttempts = [
    { _id: 'attempt-clone', quizId: cloneQuizId, userId: 'u1', status: 'completed' },
    { _id: 'attempt-normal', quizId: normalQuizId, userId: 'u1', status: 'completed' },
  ];

  // Capture what queries were made
  let quizFindQuery = null;
  let attemptFindQuery = null;

  const originalQuizFind = Quiz.find.bind(Quiz);
  const originalAttemptFind = QuizAttempt.find.bind(QuizAttempt);

  Quiz.find = (query, _projection) => {
    quizFindQuery = query;
    // Return the clone quiz docs (simulating source:'institution_assessment' filter)
    return { lean: () => Promise.resolve(cloneQuizDocs) };
  };

  QuizAttempt.find = (query) => {
    attemptFindQuery = query;
    // Return only the normal attempt (the one NOT excluded by $nin)
    const excludedIds = (query.quizId && query.quizId.$nin) || [];
    const filtered = allAttempts.filter(
      (a) => !excludedIds.some((id) => String(id) === String(a.quizId._id || a.quizId))
    );
    return {
      sort: () => ({
        populate: () => Promise.resolve(filtered),
      }),
    };
  };

  try {
    const { req, res } = makeReqRes('u1');
    await quizController.getHistory(req, res, (err) => { throw err; });

    // Verify Quiz.find was called to fetch institution clones
    assert.ok(quizFindQuery, 'Quiz.find should have been called to get institution clone ids');
    assert.strictEqual(quizFindQuery.userId, 'u1', 'Quiz.find should be scoped to the user');
    assert.strictEqual(quizFindQuery.source, 'institution_assessment', 'Quiz.find should filter source=institution_assessment');

    // Verify QuizAttempt.find has the $nin exclusion
    assert.ok(attemptFindQuery, 'QuizAttempt.find should have been called');
    assert.ok(attemptFindQuery.quizId, 'QuizAttempt.find should have quizId filter');
    assert.ok(Array.isArray(attemptFindQuery.quizId.$nin), '$nin should be an array');
    assert.strictEqual(attemptFindQuery.quizId.$nin.length, 1, 'one quiz id should be excluded');

    // Verify the response contains only the normal attempt
    const sent = res._getSent();
    assert.ok(sent, 'response should have been sent');
    assert.strictEqual(sent.data.length, 1, 'only 1 attempt should be returned (clone excluded)');
    assert.strictEqual(sent.data[0]._id, 'attempt-normal', 'the normal attempt should be returned');
  } finally {
    Quiz.find = originalQuizFind;
    QuizAttempt.find = originalAttemptFind;
  }
});

test('getHistory returns normal D2C attempts unchanged when no institution clones exist', async () => {
  // No institution clones for this user
  const originalQuizFind = Quiz.find.bind(Quiz);
  const originalAttemptFind = QuizAttempt.find.bind(QuizAttempt);

  let attemptFindQuery = null;

  Quiz.find = (_query, _projection) => {
    return { lean: () => Promise.resolve([]) }; // no clones
  };

  QuizAttempt.find = (query) => {
    attemptFindQuery = query;
    return {
      sort: () => ({
        populate: () => Promise.resolve([
          { _id: 'attempt-1', quizId: 'q1', status: 'completed' },
          { _id: 'attempt-2', quizId: 'q2', status: 'completed' },
        ]),
      }),
    };
  };

  try {
    const { req, res } = makeReqRes('u2');
    await quizController.getHistory(req, res, (err) => { throw err; });

    // When no clones, quizId filter should NOT be present (no $nin needed)
    assert.ok(!attemptFindQuery.quizId, 'quizId filter should not be set when no institution clones exist');

    const sent = res._getSent();
    assert.strictEqual(sent.data.length, 2, 'both normal attempts returned when no clones');
  } finally {
    Quiz.find = originalQuizFind;
    QuizAttempt.find = originalAttemptFind;
  }
});
