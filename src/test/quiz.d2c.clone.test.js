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

  const { req, res } = makeReqRes();
  await quizController.listQuizzes(req, res, (err) => { throw err; });

  // Restore
  Quiz.find = originalFind;

  assert.ok(capturedQuery, 'Quiz.find should have been called');
  assert.deepStrictEqual(
    capturedQuery.source,
    { $ne: 'institution_assessment' },
    'listQuizzes should exclude institution_assessment source'
  );
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

  const { req, res } = makeReqRes();
  await quizController.getSkillAssessments(req, res, (err) => { throw err; });

  Quiz.find = originalFind;

  assert.ok(capturedQuery, 'Quiz.find should have been called');
  assert.deepStrictEqual(
    capturedQuery.source,
    { $ne: 'institution_assessment' },
    'getSkillAssessments should exclude institution_assessment source'
  );
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

  const { req, res } = makeReqRes();
  await quizController.getPendingQuizzes(req, res, (err) => { throw err; });

  Quiz.find = originalFind;
  UserObjective.findOne = originalFindOne;

  assert.ok(capturedQuery, 'Quiz.find should have been called');
  assert.deepStrictEqual(
    capturedQuery.source,
    { $ne: 'institution_assessment' },
    'getPendingQuizzes should exclude institution_assessment source'
  );
});
