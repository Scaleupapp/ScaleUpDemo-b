const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

delete require.cache[require.resolve('./Plan')];
const Plan = require('./Plan');

test('Plan: validates with required fields', () => {
  const doc = new Plan({
    userId: new mongoose.Types.ObjectId(),
    objectiveId: new mongoose.Types.ObjectId(),
    diagnosticAttemptId: new mongoose.Types.ObjectId(),
    planHeadline: 'Six weeks to interview-ready PM.',
    estimatedTotalHours: 48,
    bufferRecommendation: "We've left 15% buffer for life events.",
    weeklySchedule: [{
      week: 1,
      weeklyGoal: 'Anchor your roadmapping fundamentals.',
      allocations: [
        { topicCanonicalName: 'product-strategy', hours: 3, focusActivity: 'Read + apply to your domain' },
      ],
    }],
    milestones: [{
      week: 4,
      title: 'Mock interview, behavioral round',
      measurableCriteria: 'Score 4/5 on STAR clarity rubric',
      isUserStated: false,
    }],
    source: 'llm-generated',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, 'should validate cleanly');
  assert.strictEqual(doc.weeklySchedule.length, 1);
  assert.strictEqual(doc.milestones[0].isUserStated, false);
});

test('Plan: requires userId', () => {
  const doc = new Plan({ planHeadline: 'x', estimatedTotalHours: 10, source: 'template' });
  const err = doc.validateSync();
  assert.ok(err && err.errors.userId, 'userId required');
});

test('Plan: rejects invalid source', () => {
  const doc = new Plan({
    userId: new mongoose.Types.ObjectId(),
    objectiveId: new mongoose.Types.ObjectId(),
    diagnosticAttemptId: new mongoose.Types.ObjectId(),
    planHeadline: 'x',
    estimatedTotalHours: 10,
    source: 'random',
  });
  const err = doc.validateSync();
  assert.ok(err && err.errors.source, 'invalid source enum');
});

test('Plan: defaults supersededAt to null and isActive to true', () => {
  const doc = new Plan({
    userId: new mongoose.Types.ObjectId(),
    objectiveId: new mongoose.Types.ObjectId(),
    diagnosticAttemptId: new mongoose.Types.ObjectId(),
    planHeadline: 'x',
    estimatedTotalHours: 10,
    source: 'template',
  });
  assert.strictEqual(doc.supersededAt, null);
  assert.strictEqual(doc.isActive, true);
});

test('Plan: accepts tasks[] on weeklySchedule with all six task types', () => {
  const types = ['quiz', 'in_app_content', 'ai_interview', 'external_link', 'competition', 'manual'];
  const doc = new Plan({
    userId: new mongoose.Types.ObjectId(),
    objectiveId: new mongoose.Types.ObjectId(),
    diagnosticAttemptId: new mongoose.Types.ObjectId(),
    planHeadline: 'x',
    estimatedTotalHours: 10,
    weeklySchedule: [{
      week: 1,
      weeklyGoal: 'Cover the basics',
      allocations: [],
      tasks: types.map((t, i) => ({
        type: t,
        topic: { canonicalName: 'product-strategy', displayName: 'Product Strategy' },
        payload: { stub: `payload-${i}` },
        completion: { mode: t === 'quiz' || t === 'in_app_content' || t === 'ai_interview' || t === 'competition' ? 'auto' : 'manual', requiresSelfRating: t === 'manual' || t === 'external_link' },
        progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
      })),
    }],
    source: 'llm-generated',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, 'should validate cleanly');
  assert.strictEqual(doc.weeklySchedule[0].tasks.length, 6);
  assert.strictEqual(doc.weeklySchedule[0].tasks[0].progress.status, 'pending');
});

test('Plan: rejects unknown task type', () => {
  const doc = new Plan({
    userId: new mongoose.Types.ObjectId(),
    objectiveId: new mongoose.Types.ObjectId(),
    diagnosticAttemptId: new mongoose.Types.ObjectId(),
    planHeadline: 'x',
    estimatedTotalHours: 10,
    weeklySchedule: [{
      week: 1,
      weeklyGoal: 'g',
      allocations: [],
      tasks: [{
        type: 'not_a_real_type',
        topic: { canonicalName: 'x', displayName: 'X' },
        completion: { mode: 'manual', requiresSelfRating: false },
        progress: { status: 'pending' },
      }],
    }],
    source: 'llm-generated',
  });
  const err = doc.validateSync();
  assert.ok(err, 'should fail validation on unknown type');
});
