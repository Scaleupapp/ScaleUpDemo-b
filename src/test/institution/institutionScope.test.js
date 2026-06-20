const test = require('node:test');
const assert = require('node:assert');
const { institutionScope, requireInstitutionRole, can } = require('../../middleware/institutionScope');

test('institutionScope forces institutionId from req and merges extra', () => {
  assert.deepStrictEqual(institutionScope({ institution: { institutionId: 'i1' } }, { cohortId: 'c1' }), { institutionId: 'i1', cohortId: 'c1' });
});

test('institutionScope ignores a spoofed body institutionId', () => {
  assert.strictEqual(institutionScope({ institution: { institutionId: 'i1' }, body: { institutionId: 'i2' } }).institutionId, 'i1');
});

test('institutionScope: extra cannot override the authoritative institutionId', () => {
  const out = institutionScope({ institution: { institutionId: 'i1' } }, { institutionId: 'attacker', cohortId: 'c1' });
  assert.strictEqual(out.institutionId, 'i1');
  assert.strictEqual(out.cohortId, 'c1');
});

test('institutionScope throws without institution context', () => {
  assert.throws(() => institutionScope({}));
});

test('requireInstitutionRole 403s a viewer from a head-only route', () => {
  const res = { statusCode: 0, status(c){this.statusCode=c;return this;}, json(){return this;} }; let next = false;
  requireInstitutionRole('tpo_head', 'institution_admin')({ institution: { role: 'viewer' } }, res, () => { next = true; });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(next, false);
});

test('can() gates release to head/admin only', () => {
  assert.strictEqual(can('tpo_head', 'assessment.release'), true);
  assert.strictEqual(can('tpo_coordinator', 'assessment.release'), false);
  assert.strictEqual(can('institution_admin', 'anything.at.all'), true);
});
