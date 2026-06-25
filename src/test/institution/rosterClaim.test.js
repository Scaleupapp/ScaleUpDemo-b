// src/test/institution/rosterClaim.test.js
const test = require('node:test');
const assert = require('node:assert');
const { claimForUser, claimByCode } = require('../../services/institution/rosterClaimService');

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

test('claimForUser backfills the user name from the roster when the user has none', async () => {
  const pending = { _id: 'p1', institutionId: 'i1', departmentId: 'd1', cohortId: 'c1', rollNumber: '7', name: 'Aarav Shah', status: 'invited', save: async () => {} };
  const d = deps(pending);
  let userUpdate = null;
  d.User = { updateOne: async (filter, update) => { userUpdate = { filter, update }; } };
  await claimForUser({ _id: 'u1', email: 'a@x.edu', phone: '+919800000001', firstName: 'Unknown' }, d);
  assert.ok(userUpdate, 'User.updateOne should be called');
  assert.strictEqual(userUpdate.update.$set.firstName, 'Aarav');
  assert.strictEqual(userUpdate.update.$set.lastName, 'Shah');
});

test('claimForUser does NOT overwrite an existing user name', async () => {
  const pending = { _id: 'p1', institutionId: 'i1', cohortId: 'c1', name: 'Roster Name', status: 'invited', save: async () => {} };
  const d = deps(pending);
  let called = false;
  d.User = { updateOne: async () => { called = true; } };
  await claimForUser({ _id: 'u2', email: 'a@x.edu', firstName: 'Priya' }, d);
  assert.strictEqual(called, false, 'should not clobber a real existing name');
});

test('claimByCode binds by a 6-digit code regardless of the user email', async () => {
  const pending = { _id: 'p1', institutionId: 'i1', departmentId: 'd1', cohortId: 'c1', rollNumber: '7', status: 'invited', save: async () => {} };
  const d = deps(pending);
  const enr = await claimByCode({ _id: 'u1', email: 'different@x.edu' }, '123456', d);
  assert.ok(enr);
  assert.strictEqual(d._created[0].userId, 'u1');
  assert.strictEqual(pending.status, 'claimed');
  assert.strictEqual(d._seeded.length, 1);
});

test('claimByCode rejects a malformed code (not 6 digits) without touching the DB', async () => {
  const d = deps({ _id: 'p1', save: async () => {} });
  assert.strictEqual(await claimByCode({ _id: 'u1' }, '12', d), null);
  assert.strictEqual(d._created.length, 0);
});

test('claimByCode returns null when no pending matches the code', async () => {
  const d = deps(null);
  assert.strictEqual(await claimByCode({ _id: 'u1' }, '999999', d), null);
  assert.strictEqual(d._created.length, 0);
});
