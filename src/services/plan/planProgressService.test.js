const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

delete require.cache[require.resolve('../../models/Plan')];
const Plan = require('../../models/Plan');
delete require.cache[require.resolve('./planProgressService')];
const planProgressService = require('./planProgressService');

function makePlanWithQuizTask({ status = 'pending', week = 1 } = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    weeklySchedule: [{
      week,
      weeklyGoal: 'g',
      allocations: [],
      tasks: [{
        _id: new mongoose.Types.ObjectId(),
        type: 'quiz',
        topic: { canonicalName: 'product-strategy', displayName: 'Product Strategy' },
        payload: { quizId: 'qz-1' },
        completion: { mode: 'auto', requiresSelfRating: false },
        progress: { status, completedAt: null, selfRating: null, sourceEventId: null },
      }],
    }],
    save: async function () { this._saved = true; return this; },
  };
}

test('onQuizComplete: matches first pending quiz task in current week and marks complete', async () => {
  const plan = makePlanWithQuizTask();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.onQuizComplete({
      userId: plan.userId.toString(),
      quizId: 'qz-1',
      attemptId: 'att-99',
      topic: 'product-strategy',
    });
    assert.strictEqual(out.matched, true);
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.status, 'complete');
    assert.ok(plan.weeklySchedule[0].tasks[0].progress.completedAt instanceof Date);
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.sourceEventId, 'att-99');
    assert.strictEqual(plan._saved, true);
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('onQuizComplete: returns matched=false when no plan exists', async () => {
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => null });

  try {
    const out = await planProgressService.onQuizComplete({
      userId: new mongoose.Types.ObjectId().toString(),
      quizId: 'q', attemptId: 'a', topic: 't',
    });
    assert.strictEqual(out.matched, false);
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('onQuizComplete: returns matched=false when topic does not match any task', async () => {
  const plan = makePlanWithQuizTask();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.onQuizComplete({
      userId: plan.userId.toString(),
      quizId: 'qz-1', attemptId: 'a', topic: 'unrelated-topic',
    });
    assert.strictEqual(out.matched, false);
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.status, 'pending');
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('onQuizComplete: does not retroactively complete past-week tasks', async () => {
  const plan = {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    weeklySchedule: [
      {
        week: 1,
        weeklyGoal: 'g1',
        allocations: [],
        tasks: [{
          _id: new mongoose.Types.ObjectId(),
          type: 'quiz',
          topic: { canonicalName: 'product-strategy', displayName: 'Product Strategy' },
          payload: { quizId: 'qz-1' },
          completion: { mode: 'auto', requiresSelfRating: false },
          progress: { status: 'complete', completedAt: new Date(), selfRating: null, sourceEventId: 'old' },
        }],
      },
      {
        week: 2,
        weeklyGoal: 'g2',
        allocations: [],
        tasks: [{
          _id: new mongoose.Types.ObjectId(),
          type: 'in_app_content',
          topic: { canonicalName: 'roadmapping', displayName: 'Roadmapping' },
          payload: { contentId: 'c1' },
          completion: { mode: 'auto', requiresSelfRating: false },
          progress: { status: 'pending' },
        }],
      },
    ],
    save: async function () { this._saved = true; return this; },
  };
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.onQuizComplete({
      userId: plan.userId.toString(),
      quizId: 'qz-1', attemptId: 'new-att', topic: 'product-strategy',
    });
    assert.strictEqual(out.matched, false);
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.sourceEventId, 'old');
  } finally {
    Plan.findOne = origFindOne;
  }
});

function makePlanWithContentTask() {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    weeklySchedule: [{
      week: 1,
      weeklyGoal: 'g',
      allocations: [],
      tasks: [{
        _id: new mongoose.Types.ObjectId(),
        type: 'in_app_content',
        topic: { canonicalName: 'roadmapping', displayName: 'Roadmapping' },
        payload: { contentId: 'c-42' },
        completion: { mode: 'auto', requiresSelfRating: false },
        progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
      }],
    }],
    save: async function () { this._saved = true; return this; },
  };
}

test('onContentProgress: at 79% bumps pending -> in_progress (not complete)', async () => {
  const plan = makePlanWithContentTask();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.onContentProgress({
      userId: plan.userId.toString(),
      contentId: 'c-42', percent: 79, topic: 'roadmapping',
    });
    assert.strictEqual(out.matched, true);
    assert.strictEqual(out.completed, false);
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.status, 'in_progress');
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.completedAt, null);
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('onContentProgress: at 80% marks complete', async () => {
  const plan = makePlanWithContentTask();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.onContentProgress({
      userId: plan.userId.toString(),
      contentId: 'c-42', percent: 80, topic: 'roadmapping',
    });
    assert.strictEqual(out.matched, true);
    assert.strictEqual(out.completed, true);
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.status, 'complete');
    assert.ok(plan.weeklySchedule[0].tasks[0].progress.completedAt instanceof Date);
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.sourceEventId, 'c-42');
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('onContentProgress: returns matched=false when contentId in payload does not match', async () => {
  const plan = makePlanWithContentTask();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.onContentProgress({
      userId: plan.userId.toString(),
      contentId: 'unrelated', percent: 90, topic: 'roadmapping',
    });
    assert.strictEqual(out.matched, false);
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.status, 'pending');
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('onQuizComplete: matches when caller passes loose-cased topic ("Product Strategy")', async () => {
  const plan = makePlanWithQuizTask();
  // Plan task has canonicalName 'product-strategy' (kebab). Caller passes "Product Strategy" (mixed case + spaces).
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.onQuizComplete({
      userId: plan.userId.toString(),
      quizId: 'qz-1',
      attemptId: 'att-loose',
      topic: 'Product Strategy', // <- not kebab-case
    });
    assert.strictEqual(out.matched, true, 'caller-side topic should be canonicalized before match');
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.status, 'complete');
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('onContentProgress: matches when task-side canonicalName is non-canonical (defensive)', async () => {
  const plan = makePlanWithContentTask();
  // Mutate the plan task's canonicalName to a non-canonical form to prove
  // task-side canonicalization (a plan generator could regress on this).
  plan.weeklySchedule[0].tasks[0].topic.canonicalName = 'Roadmapping ';

  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.onContentProgress({
      userId: plan.userId.toString(),
      contentId: 'c-42',
      percent: 80,
      topic: 'roadmapping',
    });
    assert.strictEqual(out.matched, true);
    assert.strictEqual(out.completed, true);
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('onQuizComplete: returns matched=false with reason="no_topic" for empty topic', async () => {
  const out = await planProgressService.onQuizComplete({
    userId: new mongoose.Types.ObjectId().toString(),
    quizId: 'q', attemptId: 'a', topic: '',
  });
  assert.strictEqual(out.matched, false);
  assert.strictEqual(out.reason, 'no_topic');
});
