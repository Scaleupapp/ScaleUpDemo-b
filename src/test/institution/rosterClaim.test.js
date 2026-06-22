// src/test/institution/rosterClaim.test.js
const test = require('node:test');
const assert = require('node:assert');
const { claimForUser } = require('../../services/institution/rosterClaimService');

function deps(pending, existing = null) {
  const created = [];
  const seeded = [];
  return {
    _created: created,
    _seeded: seeded,
    PendingStudent: { findOne: async () => pending },
    InstitutionEnrollment: { findOne: async () => existing, create: async (d) => { created.push(d); return { _id: 'e1', ...d }; } },
    objectiveBindingService: { seedObjectiveFromCohort: async (userId, cohortId, opts) => { seeded.push({ userId, cohortId, opts }); return null; } },
  };
}

test('claimForUser binds a matching pending student to an enrollment', async () => {
  const pending = { _id: 'p1', institutionId: 'i1', departmentId: 'd1', cohortId: 'c1', rollNumber: '7', status: 'invited', save: async function () { this._s = true; } };
  const d = deps(pending);
  const enr = await claimForUser({ _id: 'u1', email: 'a@x.edu', phone: '+919800000001' }, d);
  assert.strictEqual(d._created[0].userId, 'u1');
  assert.strictEqual(d._created[0].status, 'registered');
  assert.strictEqual(pending.status, 'claimed');
  assert.ok(enr);
  // the institutional objective seed fires for the new enrollment, with the cohort id
  assert.strictEqual(d._seeded.length, 1);
  assert.strictEqual(d._seeded[0].userId, 'u1');
  assert.strictEqual(d._seeded[0].cohortId, 'c1');
});

test('claimForUser returns null when no pending match', async () => {
  const d = deps(null);
  const enr = await claimForUser({ _id: 'u2', email: 'none@x.edu' }, d);
  assert.strictEqual(enr, null);
  // no enrollment created → no objective seeded
  assert.strictEqual(d._seeded.length, 0);
});

test('claimForUser is idempotent when an enrollment already exists', async () => {
  const d = deps({ _id: 'p1', institutionId: 'i1', cohortId: 'c1', save: async () => {} }, { _id: 'eX' });
  const enr = await claimForUser({ _id: 'u3', email: 'a@x.edu' }, d);
  assert.strictEqual(enr._id, 'eX');
  assert.strictEqual(d._created.length, 0);
  assert.strictEqual(d._seeded.length, 0); // existing enrollment → no new seed
});
