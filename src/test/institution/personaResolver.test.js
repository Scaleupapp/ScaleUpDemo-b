// src/test/institution/personaResolver.test.js
const test = require('node:test');
const assert = require('node:assert');
const { resolvePersona } = require('../../services/institution/personaResolver');

function fakeEnrollment(doc) {
  return { findOne: () => ({ populate: async () => doc }) };
}
// UserObjective.findOne(...).select(...) → personal objective (or null)
function fakeUO(personal) {
  return { findOne: () => ({ select: async () => personal }) };
}
// User.findById(...).select(...) → user doc (or null)
function fakeUser(preferredContext) {
  return { findById: () => ({ select: async () => ({ preferredContext }) }) };
}

const ENROLLED = {
  status: 'active',
  institutionId: { _id: 'i1', name: 'Northgate IT', logoUrl: null, brandColor: '#F2C75A' },
  cohortId: { _id: 'c1', year: 'final', label: 'CSE Final 2026', placementSeason: { endDate: '2027-03-01' } },
};

test('Case 1 — no enrollment → general (pure D2C, unchanged)', async () => {
  const out = await resolvePersona('u', { Enrollment: fakeEnrollment(null) });
  assert.strictEqual(out.persona, 'general');
  assert.strictEqual(out.placement, undefined);
});

test('Case 2 — enrolled, no personal objective → placement (pure placement, unchanged)', async () => {
  const out = await resolvePersona('u', {
    Enrollment: fakeEnrollment(ENROLLED),
    UserObjective: fakeUO(null),
    User: fakeUser(null),
  });
  assert.strictEqual(out.persona, 'placement');
  assert.strictEqual(out.placement.institution.name, 'Northgate IT');
  assert.strictEqual(out.placement.objective.locked, true);
  assert.strictEqual(out.needsContextChoice, undefined);
});

test('Case 3 — dual, no choice yet → needsContextChoice (default placement backdrop)', async () => {
  const out = await resolvePersona('u', {
    Enrollment: fakeEnrollment(ENROLLED),
    UserObjective: fakeUO({ _id: 'o-personal' }),
    User: fakeUser(null),
  });
  assert.strictEqual(out.persona, 'placement');
  assert.strictEqual(out.needsContextChoice, true);
  assert.deepStrictEqual(out.availableContexts, ['placement', 'personal']);
});

test('Case 3 — dual, chose personal → general shell, activeContext personal', async () => {
  const out = await resolvePersona('u', {
    Enrollment: fakeEnrollment(ENROLLED),
    UserObjective: fakeUO({ _id: 'o-personal' }),
    User: fakeUser('personal'),
  });
  assert.strictEqual(out.persona, 'general');
  assert.strictEqual(out.activeContext, 'personal');
  assert.ok(out.placement, 'placement block still provided so the user can switch back');
});

test('Case 3 — dual, chose placement → placement shell, activeContext placement', async () => {
  const out = await resolvePersona('u', {
    Enrollment: fakeEnrollment(ENROLLED),
    UserObjective: fakeUO({ _id: 'o-personal' }),
    User: fakeUser('placement'),
  });
  assert.strictEqual(out.persona, 'placement');
  assert.strictEqual(out.activeContext, 'placement');
});
