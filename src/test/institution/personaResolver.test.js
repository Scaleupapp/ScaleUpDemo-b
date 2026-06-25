// src/test/institution/personaResolver.test.js
const test = require('node:test');
const assert = require('node:assert');
const { resolvePersona } = require('../../services/institution/personaResolver');

function fakeEnrollment(doc) {
  return { findOne: () => ({ populate: async () => doc }) };
}

test('returns placement persona when an enrollment exists', async () => {
  const Enrollment = fakeEnrollment({
    status: 'active',
    institutionId: { _id: 'i1', name: 'Northgate IT', logoUrl: null, brandColor: '#F2C75A' },
    cohortId: { _id: 'c1', year: 'final', label: 'CSE Final 2026', placementSeason: { endDate: '2027-03-01' } },
  });
  const out = await resolvePersona('u1', { Enrollment });
  assert.strictEqual(out.persona, 'placement');
  assert.strictEqual(out.placement.institution.name, 'Northgate IT');
  assert.strictEqual(out.placement.objective.locked, true);
});

test('returns general persona when no enrollment (pure D2C — unchanged)', async () => {
  const out = await resolvePersona('u2', { Enrollment: fakeEnrollment(null) });
  assert.strictEqual(out.persona, 'general');
  assert.strictEqual(out.placement, undefined);
});
