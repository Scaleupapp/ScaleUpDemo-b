'use strict';
const test = require('node:test');
const assert = require('node:assert');
const PlacementDrive = require('../../models/PlacementDrive');

test('PlacementDrive requires institutionId, cohortId, name', () => {
  const err = new PlacementDrive({}).validateSync();
  assert.ok(err.errors.institutionId, 'institutionId required');
  assert.ok(err.errors.cohortId, 'cohortId required');
  assert.ok(err.errors.name, 'name required');
});

test('PlacementDrive defaults status to upcoming and accepts the enum', () => {
  const oid = '507f1f77bcf86cd799439011';
  const d = new PlacementDrive({ institutionId: oid, cohortId: oid, name: 'Acme' });
  assert.strictEqual(d.status, 'upcoming');
  const bad = new PlacementDrive({ institutionId: oid, cohortId: oid, name: 'Acme', status: 'nope' }).validateSync();
  assert.ok(bad.errors.status, 'invalid status rejected');
});

test('PlacementDrive keeps optional fields', () => {
  const oid = '507f1f77bcf86cd799439011';
  const d = new PlacementDrive({ institutionId: oid, cohortId: oid, name: 'Acme', role: 'SDE', package: '12 LPA', eligibility: 'CGPA 7+', applyLink: 'https://x', notes: 'round 1 online' });
  assert.strictEqual(d.role, 'SDE');
  assert.strictEqual(d.package, '12 LPA');
});
