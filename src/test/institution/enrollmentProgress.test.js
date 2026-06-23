'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { markDiagnosticDone } = require('../../services/institution/enrollmentProgressService');

test('markDiagnosticDone moves registered enrollments to diagnostic_done', async () => {
  let captured = null;
  const InstitutionEnrollment = {
    updateMany: async (filter, update) => { captured = { filter, update }; return { matchedCount: 1, modifiedCount: 1 }; },
  };
  const res = await markDiagnosticDone('u1', { InstitutionEnrollment });
  assert.deepStrictEqual(captured.filter, { userId: 'u1', status: 'registered' });
  assert.deepStrictEqual(captured.update, { $set: { status: 'diagnostic_done' } });
  assert.strictEqual(res.modifiedCount, 1);
});

test('markDiagnosticDone is a no-op for a missing userId', async () => {
  let called = false;
  const InstitutionEnrollment = { updateMany: async () => { called = true; } };
  const res = await markDiagnosticDone(null, { InstitutionEnrollment });
  assert.strictEqual(res, null);
  assert.strictEqual(called, false);
});
