const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const planModelPath = require.resolve('../models/Plan');
const attemptModelPath = require.resolve('../models/DiagnosticAttempt');
const objectiveModelPath = require.resolve('../models/UserObjective');
const taxonomyModelPath = require.resolve('../models/TopicTaxonomy');
const taxonomyServicePath = require.resolve('../services/diagnostic/topicTaxonomyService');

let activePlan = null;
let latestAttempt = null;
let activeObjective = null;
let activeTaxonomy = null;
require.cache[planModelPath] = {
  exports: {
    findOne: (filter) => ({ sort: () => ({ lean: async () => activePlan }) }),
  },
};
require.cache[attemptModelPath] = {
  exports: {
    findOne: (filter) => ({ sort: () => ({ select: () => ({ lean: async () => latestAttempt }) }) }),
  },
};
require.cache[objectiveModelPath] = {
  exports: {
    findById: (id) => ({ lean: async () => activeObjective }),
  },
};
require.cache[taxonomyModelPath] = {
  exports: {
    findOne: (filter) => ({ lean: async () => activeTaxonomy }),
  },
};
require.cache[taxonomyServicePath] = {
  exports: {
    buildTargetKey: (type, specifics) => `${type}::${specifics?.targetSkill || specifics?.examName || specifics?.targetRole || 'default'}`,
    canonicalize: (s) => String(s || '').toLowerCase().replace(/\s+/g, '-'),
  },
};

delete require.cache[require.resolve('./planController')];
const ctrl = require('./planController');

function fakeRes() {
  const r = { _status: 200, _json: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

test('planController.getStatus: returns generating when no plan yet', async () => {
  activePlan = null;
  latestAttempt = { planGenerationStatus: 'generating' };
  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getStatus(req, res);
  // Response must be wrapped in the standard {success, data} envelope —
  // iOS APIClient strict-decodes that shape and bombs out otherwise.
  assert.strictEqual(res._json.success, true);
  assert.strictEqual(res._json.data.status, 'generating');
});

test('planController.getStatus: returns pending with planId:null when user has no attempts', async () => {
  activePlan = null;
  latestAttempt = null;
  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getStatus(req, res);
  assert.strictEqual(res._json.success, true);
  assert.strictEqual(res._json.data.status, 'pending');
  assert.strictEqual(res._json.data.planId, null);
});

test('planController.getStatus: returns ready when plan exists', async () => {
  activePlan = { _id: new mongoose.Types.ObjectId(), source: 'llm-generated', updatedAt: new Date() };
  latestAttempt = { planGenerationStatus: 'ready', planId: activePlan._id };
  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getStatus(req, res);
  assert.strictEqual(res._json.success, true);
  assert.strictEqual(res._json.data.status, 'ready');
  assert.ok(res._json.data.planId);
});

test('planController.getCurrent: returns the active plan', async () => {
  activePlan = {
    _id: new mongoose.Types.ObjectId(),
    planHeadline: 'h',
    estimatedTotalHours: 10,
    weeklySchedule: [],
    milestones: [],
    source: 'template',
  };
  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getCurrent(req, res);
  assert.strictEqual(res._json.success, true);
  assert.strictEqual(res._json.data.planHeadline, 'h');
  assert.strictEqual(res._json.data.source, 'template');
});

test('planController.getCurrent: returns 404 when no plan', async () => {
  activePlan = null;
  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getCurrent(req, res);
  assert.strictEqual(res._status, 404);
});

// ---------------------------------------------------------------------------
// CONTRACT TESTS: lock the /plan/current response shape against the iOS
// PlanDTO defined in ScaleUp/Features/Plan/Services/PlanService.swift.
// If you change the shape on either side, this test should fail loudly.
// ---------------------------------------------------------------------------

const IOS_PLAN_DTO_REQUIRED = ['planId', 'planHeadline', 'totalWeeks', 'totalHours', 'milestoneCount', 'weeklySchedule', 'milestones'];
const IOS_PLAN_DTO_OPTIONAL = ['bufferRecommendation', 'source'];
const IOS_WEEKLY_ENTRY_REQUIRED = ['weekNumber', 'weekLabel', 'totalHours', 'allocations'];
const IOS_ALLOCATION_REQUIRED = ['topic', 'hoursAllocated', 'focusActivity'];
const IOS_ALLOCATION_OPTIONAL = ['canonicalTopic'];
const IOS_MILESTONE_REQUIRED = ['title', 'measurableCriteria', 'weekTarget', 'isUserStated'];

test('planController.getCurrent: response shape matches iOS PlanDTO contract', async () => {
  activePlan = {
    _id: new mongoose.Types.ObjectId(),
    objectiveId: new mongoose.Types.ObjectId(),
    planHeadline: 'Sprint to senior PM in 12 weeks',
    estimatedTotalHours: 72,
    bufferRecommendation: '2h/week buffer',
    weeklySchedule: [
      {
        week: 1,
        weeklyGoal: 'Foundations',
        allocations: [
          { topicCanonicalName: 'product-strategy', hours: 3, focusActivity: 'reading + exercises' },
          { topicCanonicalName: 'user-research',    hours: 2, focusActivity: 'video + practice' },
        ],
      },
      {
        week: 2,
        weeklyGoal: 'Strategy deep-dive',
        allocations: [
          { topicCanonicalName: 'product-strategy', hours: 4, focusActivity: 'case studies' },
        ],
      },
    ],
    milestones: [
      { week: 4,  title: 'First case study completed', measurableCriteria: '1 case study graded', isUserStated: false },
      { week: 12, title: 'Mock interview pass',         measurableCriteria: 'Score ≥ 80%',         isUserStated: true },
    ],
    source: 'llm-generated',
  };
  activeObjective = {
    _id: activePlan.objectiveId,
    objectiveType: 'upskilling',
    specifics: { targetSkill: 'Product Management' },
    specificsCanonical: { targetSkill: 'product-management' },
  };
  activeTaxonomy = {
    objectiveType: 'upskilling',
    targetKey: 'upskilling::product-management',
    topics: [
      { canonicalName: 'product-strategy', name: 'Product Strategy' },
      { canonicalName: 'user-research',    name: 'User Research' },
    ],
  };

  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getCurrent(req, res);

  assert.strictEqual(res._status, 200);
  // Response is wrapped in {success, data} envelope.
  assert.strictEqual(res._json.success, true, 'response must be wrapped in success envelope');
  const body = res._json.data;

  // Top-level required fields
  for (const k of IOS_PLAN_DTO_REQUIRED) {
    assert.ok(Object.prototype.hasOwnProperty.call(body, k), `iOS PlanDTO requires '${k}' on response, got ${Object.keys(body).join(',')}`);
    assert.ok(body[k] !== undefined && body[k] !== null, `'${k}' must not be null/undefined on response`);
  }
  // Optional fields may be present
  for (const k of IOS_PLAN_DTO_OPTIONAL) {
    if (k in body) assert.ok(typeof body[k] === 'string' || body[k] === null);
  }

  // Type expectations
  assert.strictEqual(typeof body.planId,         'string');
  assert.strictEqual(typeof body.planHeadline,   'string');
  assert.strictEqual(typeof body.totalWeeks,     'number');
  assert.strictEqual(typeof body.totalHours,     'number');
  assert.strictEqual(typeof body.milestoneCount, 'number');
  assert.ok(Array.isArray(body.weeklySchedule));
  assert.ok(Array.isArray(body.milestones));

  // Derived values
  assert.strictEqual(body.totalWeeks, 2, 'totalWeeks should equal weeklySchedule.length');
  assert.strictEqual(body.milestoneCount, 2, 'milestoneCount should equal milestones.length');

  // Weekly entry shape
  for (const w of body.weeklySchedule) {
    for (const k of IOS_WEEKLY_ENTRY_REQUIRED) {
      assert.ok(Object.prototype.hasOwnProperty.call(w, k), `WeeklyEntry requires '${k}', got ${Object.keys(w).join(',')}`);
    }
    assert.strictEqual(typeof w.weekNumber, 'number');
    assert.strictEqual(typeof w.weekLabel,  'string');
    assert.strictEqual(typeof w.totalHours, 'number');
    assert.ok(Array.isArray(w.allocations));

    // Allocation shape
    for (const a of w.allocations) {
      for (const k of IOS_ALLOCATION_REQUIRED) {
        assert.ok(Object.prototype.hasOwnProperty.call(a, k), `Allocation requires '${k}', got ${Object.keys(a).join(',')}`);
      }
      assert.strictEqual(typeof a.topic,          'string');
      assert.strictEqual(typeof a.hoursAllocated, 'number');
      assert.strictEqual(typeof a.focusActivity,  'string');
    }
  }

  // Milestone shape
  for (const m of body.milestones) {
    for (const k of IOS_MILESTONE_REQUIRED) {
      assert.ok(Object.prototype.hasOwnProperty.call(m, k), `Milestone requires '${k}', got ${Object.keys(m).join(',')}`);
    }
    assert.strictEqual(typeof m.title,             'string');
    assert.strictEqual(typeof m.measurableCriteria,'string');
    assert.strictEqual(typeof m.weekTarget,        'number');
    assert.strictEqual(typeof m.isUserStated,      'boolean');
  }

  // Specific name mapping: topicCanonicalName → topic display name from taxonomy
  const firstAlloc = body.weeklySchedule[0].allocations[0];
  assert.strictEqual(firstAlloc.topic, 'Product Strategy', 'topic should be display name from taxonomy');
  assert.strictEqual(firstAlloc.canonicalTopic, 'product-strategy', 'canonicalTopic should be the canonical name');
});

test('planController.getCurrent: falls back to canonical names when taxonomy lookup fails', async () => {
  activePlan = {
    _id: new mongoose.Types.ObjectId(),
    objectiveId: new mongoose.Types.ObjectId(),
    planHeadline: 'h',
    estimatedTotalHours: 5,
    weeklySchedule: [{ week: 1, weeklyGoal: 'g', allocations: [{ topicCanonicalName: 'foo', hours: 5, focusActivity: 'x' }] }],
    milestones: [],
    source: 'template',
  };
  activeObjective = null;   // taxonomy lookup will fail safely
  activeTaxonomy = null;

  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getCurrent(req, res);
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.success, true);
  assert.strictEqual(res._json.data.weeklySchedule[0].allocations[0].topic, 'foo', 'falls back to canonical when no taxonomy');
});
