'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

delete require.cache[require.resolve('./weeklyAutoCalibrationWorker')];
const worker = require('./weeklyAutoCalibrationWorker');

const QuizAttempt = require('../models/QuizAttempt');
const ContentProgress = require('../models/ContentProgress');
const InterviewSession = require('../models/InterviewSession');
const ExternalContentTouch = require('../models/ExternalContentTouch');
const taskCatalogService = require('../services/plan/taskCatalogService');

test('computeSignal: aggregates counts across 4 collections', async () => {
  const origs = [
    QuizAttempt.countDocuments,
    ContentProgress.countDocuments,
    InterviewSession.countDocuments,
    ExternalContentTouch.countDocuments,
  ];
  QuizAttempt.countDocuments = async () => 3;
  ContentProgress.countDocuments = async () => 2;
  InterviewSession.countDocuments = async () => 1;
  ExternalContentTouch.countDocuments = async () => 1;
  try {
    const signal = await worker._internal.computeSignal(
      new mongoose.Types.ObjectId(),
      new Date()
    );
    // 3 + 2 + 2*1 + 1 = 8
    assert.strictEqual(signal, 8);
  } finally {
    QuizAttempt.countDocuments = origs[0];
    ContentProgress.countDocuments = origs[1];
    InterviewSession.countDocuments = origs[2];
    ExternalContentTouch.countDocuments = origs[3];
  }
});

test('softRealignPlan: refreshes pending quiz/content, preserves completed and other types', async () => {
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({
    quizId: 'newQuiz',
    quizMinutes: 8,
    contentId: 'newContent',
    contentType: 'article',
    contentMinutes: 12,
  });

  const completedQuiz = {
    type: 'quiz',
    topic: { canonicalName: 'a', displayName: 'A' },
    payload: { quizId: 'oldQuiz', estimatedMinutes: 8 },
    progress: { status: 'complete' },
  };
  const pendingQuiz = {
    type: 'quiz',
    topic: { canonicalName: 'b', displayName: 'B' },
    payload: { quizId: 'oldB' },
    progress: { status: 'pending' },
  };
  const interviewTask = {
    type: 'ai_interview',
    topic: { canonicalName: '_objective', displayName: 'Mock interview' },
    progress: { status: 'pending' },
  };
  const plan = {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    objectiveId: new mongoose.Types.ObjectId(),
    weeklySchedule: [{
      week: 1,
      weeklyGoal: 'g',
      allocations: [{ topicCanonicalName: 'a' }, { topicCanonicalName: 'b' }],
      tasks: [completedQuiz, pendingQuiz, interviewTask],
    }],
    save: async function () { this._saved = true; return this; },
  };

  try {
    const weeksTouched = await worker._internal.softRealignPlan(
      plan,
      'upskilling',
      { targetSkill: 's' }
    );
    assert.strictEqual(weeksTouched, 1);
    const week = plan.weeklySchedule[0];
    // The interview task was preserved
    assert.ok(week.tasks.some(t => t.type === 'ai_interview'));
    // Completed quiz for 'a' is preserved (not duplicated)
    const aQuizzes = week.tasks.filter(t => t.type === 'quiz' && t.topic?.canonicalName === 'a');
    assert.strictEqual(
      aQuizzes.length,
      1,
      'completed quiz preserved, no new quiz emitted for completed topic'
    );
    assert.strictEqual(aQuizzes[0].progress.status, 'complete');
    // Pending quiz for 'b' was replaced with the new resolved quiz
    const bQuizzes = week.tasks.filter(t => t.type === 'quiz' && t.topic?.canonicalName === 'b');
    assert.strictEqual(bQuizzes.length, 1);
    assert.strictEqual(bQuizzes[0].payload.quizId, 'newQuiz');
    assert.strictEqual(bQuizzes[0].progress.status, 'pending');
    // New content tasks were emitted for both topics (no completed content existed)
    const contents = week.tasks.filter(t => t.type === 'in_app_content');
    assert.strictEqual(contents.length, 2);
    assert.strictEqual(plan._saved, true);
  } finally {
    taskCatalogService.resolveTopic = origResolve;
  }
});
