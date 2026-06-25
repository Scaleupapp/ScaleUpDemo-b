'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { seedObjectiveFromCohort } = require('../../services/institution/objectiveBindingService');

function makeDeps({ cohort, template, existing = null, priorPrimary = null } = {}) {
  const state = { demoteCalls: [], saved: null };
  class FakeUO {
    constructor(data) { Object.assign(this, data); this.$locals = {}; }
    async save() { state.saved = this; return this; }
  }
  // Filter-aware: the idempotency check queries by institutionContext.cohortId;
  // the dual-context guard queries by isPrimary. Return the right stub for each.
  FakeUO.findOne = async (filter = {}) => {
    if (filter['institutionContext.cohortId'] !== undefined) return existing;
    if (filter.isPrimary) return priorPrimary;
    return null;
  };
  FakeUO.updateMany = async (filter, update) => { state.demoteCalls.push({ filter, update }); return { acknowledged: true }; };
  return {
    _state: state,
    InstitutionCohort: { findById: async () => cohort },
    ObjectiveTemplate: { findById: async () => template },
    UserObjective: FakeUO,
  };
}

const COHORT = { _id: 'c1', institutionId: 'i1', objectiveTemplateId: 't1', placementSeason: { endDate: new Date('2026-12-01') } };
const TEMPLATE = { _id: 't1', institutionId: 'i1', objectiveType: 'interview_preparation', specifics: { targetRole: 'SWE' }, competencies: [{ name: 'DSA', weight: 9, category: 'core' }] };

test('seeds a locked institutional objective from the cohort template', async () => {
  const deps = makeDeps({ cohort: COHORT, template: TEMPLATE });
  const obj = await seedObjectiveFromCohort('u1', 'c1', { assignedBy: 'admin1', deps });
  assert.ok(obj);
  assert.strictEqual(obj.userId, 'u1');
  assert.strictEqual(obj.objectiveType, 'interview_preparation');
  assert.strictEqual(obj.isPrimary, true);
  assert.strictEqual(obj.status, 'active');
  assert.strictEqual(obj.institutionContext.locked, true);
  assert.strictEqual(String(obj.institutionContext.cohortId), 'c1');
  assert.strictEqual(String(obj.institutionContext.templateId), 't1');
  assert.strictEqual(String(obj.institutionContext.assignedBy), 'admin1');
  assert.strictEqual(obj.analysis.competencies[0].name, 'DSA');
  assert.deepStrictEqual(obj.targetDate, new Date('2026-12-01')); // deadline injected
  // directory pollution guard set
  assert.strictEqual(obj.$locals.skipInstitutionalDirectory, true);
  // prior primaries demoted
  assert.strictEqual(deps._state.demoteCalls.length, 1);
  assert.strictEqual(deps._state.demoteCalls[0].update.$set.isPrimary, false);
});

test('DUAL-context: when the user already has a personal primary, the institutional objective is added NON-primary and the personal primary is NOT demoted', async () => {
  const deps = makeDeps({ cohort: COHORT, template: TEMPLATE, priorPrimary: { _id: 'personal-obj', isPrimary: true } });
  const obj = await seedObjectiveFromCohort('u1', 'c1', { assignedBy: 'admin1', deps });
  assert.ok(obj);
  assert.strictEqual(obj.isPrimary, false, 'institutional objective must NOT be primary for a dual user');
  assert.strictEqual(obj.institutionContext.locked, true);
  assert.strictEqual(deps._state.demoteCalls.length, 0, 'must NOT demote the personal primary');
});

test('no-op (null) when the cohort has no template', async () => {
  const deps = makeDeps({ cohort: { _id: 'c1', institutionId: 'i1', objectiveTemplateId: null }, template: null });
  const obj = await seedObjectiveFromCohort('u1', 'c1', { deps });
  assert.strictEqual(obj, null);
  assert.strictEqual(deps._state.saved, null);
  assert.strictEqual(deps._state.demoteCalls.length, 0);
});

test('no-op (null) when the template doc is missing', async () => {
  const deps = makeDeps({ cohort: COHORT, template: null });
  const obj = await seedObjectiveFromCohort('u1', 'c1', { deps });
  assert.strictEqual(obj, null);
});

test('idempotent — returns existing institutional objective without re-seeding', async () => {
  const existing = { _id: 'existing', userId: 'u1' };
  const deps = makeDeps({ cohort: COHORT, template: TEMPLATE, existing });
  const obj = await seedObjectiveFromCohort('u1', 'c1', { deps });
  assert.strictEqual(obj._id, 'existing');
  assert.strictEqual(deps._state.saved, null);       // did not create
  assert.strictEqual(deps._state.demoteCalls.length, 0); // did not demote
});

test('null userId/cohortId → null', async () => {
  assert.strictEqual(await seedObjectiveFromCohort(null, 'c1', { deps: makeDeps() }), null);
  assert.strictEqual(await seedObjectiveFromCohort('u1', null, { deps: makeDeps() }), null);
});
