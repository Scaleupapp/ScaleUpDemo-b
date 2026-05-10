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

test('onQuizComplete: retries on VersionError and succeeds on second attempt', async () => {
  let saveAttempts = 0;
  const plan = makePlanWithQuizTask();
  const origSave = plan.save;
  plan.save = async function () {
    saveAttempts++;
    if (saveAttempts === 1) {
      const err = new Error('No matching document found for ... __v=5');
      err.name = 'VersionError';
      throw err;
    }
    this._saved = true;
    return this;
  };

  let loadCount = 0;
  const origFindOne = Plan.findOne;
  Plan.findOne = () => {
    loadCount++;
    return { sort: () => plan };
  };

  try {
    const out = await planProgressService.onQuizComplete({
      userId: plan.userId.toString(),
      quizId: 'qz-1', attemptId: 'att-retry', topic: 'product-strategy',
    });
    assert.strictEqual(out.matched, true, 'should succeed after retry');
    assert.strictEqual(saveAttempts, 2, 'should have attempted save twice');
    assert.strictEqual(loadCount, 2, 'should have re-loaded after VersionError');
    assert.strictEqual(plan._saved, true);
  } finally {
    Plan.findOne = origFindOne;
    plan.save = origSave;
  }
});

test('onQuizComplete: returns concurrent_update after MAX_RETRIES VersionErrors', async () => {
  let saveAttempts = 0;
  const plan = makePlanWithQuizTask();
  const origSave = plan.save;
  plan.save = async function () {
    saveAttempts++;
    const err = new Error('VersionError');
    err.name = 'VersionError';
    throw err;
  };

  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.onQuizComplete({
      userId: plan.userId.toString(),
      quizId: 'qz-1', attemptId: 'att-fail', topic: 'product-strategy',
    });
    assert.strictEqual(out.matched, false);
    assert.strictEqual(out.reason, 'concurrent_update');
    assert.ok(saveAttempts >= 3, `expected at least 3 save attempts, got ${saveAttempts}`);
  } finally {
    Plan.findOne = origFindOne;
    plan.save = origSave;
  }
});

test('onContentProgress: retries on VersionError', async () => {
  let saveAttempts = 0;
  const plan = makePlanWithContentTask();
  const origSave = plan.save;
  plan.save = async function () {
    saveAttempts++;
    if (saveAttempts === 1) {
      const err = new Error('VersionError');
      err.name = 'VersionError';
      throw err;
    }
    this._saved = true;
    return this;
  };

  // Reset task progress between simulated reloads is unnecessary since the
  // test reuses the same in-memory plan object — both attempts see the same
  // pending task. The point is just that the second save() succeeds.
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.onContentProgress({
      userId: plan.userId.toString(),
      contentId: 'c-42', percent: 80, topic: 'roadmapping',
    });
    assert.strictEqual(out.matched, true);
    assert.strictEqual(out.completed, true);
    assert.strictEqual(saveAttempts, 2);
  } finally {
    Plan.findOne = origFindOne;
    plan.save = origSave;
  }
});

function makePlanWithInterviewTask() {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    weeklySchedule: [{
      week: 1,
      weeklyGoal: 'g',
      allocations: [],
      tasks: [{
        _id: new mongoose.Types.ObjectId(),
        type: 'ai_interview',
        topic: { canonicalName: 'product-strategy', displayName: 'Product Strategy' },
        payload: { scenario: 'placement_behavioral', estimatedMinutes: 15 },
        completion: { mode: 'auto', requiresSelfRating: false },
        progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
      }],
    }],
    save: async function () { this._saved = true; return this; },
  };
}

function makePlanWithCompetitionTask() {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    weeklySchedule: [{
      week: 1,
      weeklyGoal: 'g',
      allocations: [],
      tasks: [{
        _id: new mongoose.Types.ObjectId(),
        type: 'competition',
        topic: { canonicalName: 'product-strategy', displayName: 'Product Strategy' },
        payload: { topicCanonicalName: 'product-strategy', estimatedMinutes: 8 },
        completion: { mode: 'auto', requiresSelfRating: false },
        progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
      }],
    }],
    save: async function () { this._saved = true; return this; },
  };
}

function makePlanWithManualTask() {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    weeklySchedule: [{
      week: 1,
      weeklyGoal: 'g',
      allocations: [],
      tasks: [{
        _id: new mongoose.Types.ObjectId(),
        type: 'manual',
        topic: { canonicalName: 'product-strategy', displayName: 'Product Strategy' },
        payload: { title: 'Practice on your own', description: 'x', estimatedMinutes: 30 },
        completion: { mode: 'manual', requiresSelfRating: true },
        progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
      }],
    }],
    save: async function () { this._saved = true; return this; },
  };
}

test('onInterviewComplete: matches ai_interview task and marks complete', async () => {
  const plan = makePlanWithInterviewTask();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });
  try {
    const out = await planProgressService.onInterviewComplete({
      userId: plan.userId.toString(),
      sessionId: 'sess-99',
      topic: 'product-strategy',
    });
    assert.strictEqual(out.matched, true);
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.status, 'complete');
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.sourceEventId, 'sess-99');
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('onCompetitionPlayed: matches competition task and marks complete', async () => {
  const plan = makePlanWithCompetitionTask();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });
  try {
    const out = await planProgressService.onCompetitionPlayed({
      userId: plan.userId.toString(),
      challengeId: 'ch-99',
      topic: 'product-strategy',
    });
    assert.strictEqual(out.matched, true);
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.status, 'complete');
    assert.strictEqual(plan.weeklySchedule[0].tasks[0].progress.sourceEventId, 'ch-99');
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('markManualComplete: marks task complete with selfRating', async () => {
  const plan = makePlanWithManualTask();
  const taskId = plan.weeklySchedule[0].tasks[0]._id.toString();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });
  try {
    const out = await planProgressService.markManualComplete({
      userId: plan.userId.toString(),
      taskId,
      selfRating: 4,
    });
    assert.strictEqual(out.matched, true);
    const task = plan.weeklySchedule[0].tasks[0];
    assert.strictEqual(task.progress.status, 'complete');
    assert.strictEqual(task.progress.selfRating, 4);
    assert.ok(task.progress.completedAt instanceof Date);
    assert.ok(typeof task.progress.sourceEventId === 'string' && task.progress.sourceEventId.startsWith('manual_'));
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('markManualComplete: rejects selfRating outside 1-5', async () => {
  const plan = makePlanWithManualTask();
  const taskId = plan.weeklySchedule[0].tasks[0]._id.toString();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });
  try {
    const out = await planProgressService.markManualComplete({
      userId: plan.userId.toString(),
      taskId,
      selfRating: 99,
    });
    assert.strictEqual(out.matched, false);
    assert.strictEqual(out.reason, 'invalid_self_rating');
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('markManualComplete: returns matched=false when taskId not in plan', async () => {
  const plan = makePlanWithManualTask();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });
  try {
    const out = await planProgressService.markManualComplete({
      userId: plan.userId.toString(),
      taskId: new mongoose.Types.ObjectId().toString(),
      selfRating: 3,
    });
    assert.strictEqual(out.matched, false);
    assert.strictEqual(out.reason, 'task_not_found');
  } finally {
    Plan.findOne = origFindOne;
  }
});

test('markManualComplete: writes ExternalContentTouch when task type is external_link', async () => {
  const ExternalContentTouch = require('../../models/ExternalContentTouch');
  const inserted = [];
  const origCreate = ExternalContentTouch.create;
  ExternalContentTouch.create = async (doc) => { inserted.push(doc); return doc; };

  const plan = {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    weeklySchedule: [{
      week: 1, weeklyGoal: 'g', allocations: [],
      tasks: [{
        _id: new mongoose.Types.ObjectId(),
        type: 'external_link',
        topic: { canonicalName: 'react-hooks', displayName: 'React Hooks' },
        payload: { url: 'https://ocw.mit.edu/x', title: 'MIT OCW: X', source: 'mit', why: 'r', estimatedMinutes: 30 },
        completion: { mode: 'manual', requiresSelfRating: true },
        progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
      }],
    }],
    save: async function () { this._saved = true; return this; },
  };
  const taskId = plan.weeklySchedule[0].tasks[0]._id.toString();

  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    const out = await planProgressService.markManualComplete({
      userId: plan.userId.toString(),
      taskId,
      selfRating: 4,
    });
    assert.strictEqual(out.matched, true);
    assert.strictEqual(inserted.length, 1, 'should insert one ExternalContentTouch');
    assert.strictEqual(inserted[0].url, 'https://ocw.mit.edu/x');
    assert.strictEqual(inserted[0].selfRating, 4);
    assert.strictEqual(inserted[0].topicCanonicalName, 'react-hooks');
    assert.strictEqual(String(inserted[0].userId), plan.userId.toString());
  } finally {
    Plan.findOne = origFindOne;
    ExternalContentTouch.create = origCreate;
  }
});

test('markManualComplete: does NOT write ExternalContentTouch for non-external_link tasks', async () => {
  const ExternalContentTouch = require('../../models/ExternalContentTouch');
  const inserted = [];
  const origCreate = ExternalContentTouch.create;
  ExternalContentTouch.create = async (doc) => { inserted.push(doc); return doc; };

  const plan = makePlanWithManualTask(); // existing factory from Phase 3 tests
  const taskId = plan.weeklySchedule[0].tasks[0]._id.toString();
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ sort: () => plan });

  try {
    await planProgressService.markManualComplete({
      userId: plan.userId.toString(),
      taskId,
      selfRating: 3,
    });
    assert.strictEqual(inserted.length, 0, 'manual tasks should not produce ExternalContentTouch rows');
  } finally {
    Plan.findOne = origFindOne;
    ExternalContentTouch.create = origCreate;
  }
});
