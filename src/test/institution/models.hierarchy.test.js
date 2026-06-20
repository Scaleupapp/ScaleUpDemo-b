const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
delete require.cache[require.resolve('../../models/Institution')];
delete require.cache[require.resolve('../../models/Department')];
delete require.cache[require.resolve('../../models/InstitutionCohort')];
const Institution = require('../../models/Institution');
const Department = require('../../models/Department');
const InstitutionCohort = require('../../models/InstitutionCohort');

test('Institution requires name and defaults seatsUsed to 0', () => {
  assert.ok(new Institution({}).validateSync().errors.name, 'name required');
  const ok = new Institution({ name: 'Northgate IT' });
  assert.strictEqual(ok.validateSync(), undefined);
  assert.strictEqual(ok.seatsUsed, 0);
});

test('Department requires institutionId and rejects unknown capability track', () => {
  const d = new Department({ institutionId: new mongoose.Types.ObjectId(), name: 'CSE', code: 'CSE', capabilityTracks: ['quantum'] });
  assert.ok(d.validateSync().errors['capabilityTracks.0'], 'bad track rejected');
});

test('InstitutionCohort enforces year enum', () => {
  const bad = new InstitutionCohort({ institutionId: new mongoose.Types.ObjectId(), departmentId: new mongoose.Types.ObjectId(), year: 'sophomore', label: 'X' });
  assert.ok(bad.validateSync().errors.year, 'year enum enforced');
  const ok = new InstitutionCohort({ institutionId: new mongoose.Types.ObjectId(), departmentId: new mongoose.Types.ObjectId(), year: 'final', label: 'CSE Final 2026' });
  assert.strictEqual(ok.validateSync(), undefined);
});
