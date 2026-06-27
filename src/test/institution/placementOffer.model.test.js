'use strict';
const test = require('node:test'); const assert = require('node:assert');
const PlacementOffer = require('../../models/PlacementOffer');
const oid = '507f1f77bcf86cd799439011';
test('PlacementOffer requires institutionId, cohortId, studentName, companyName', () => {
  const e = new PlacementOffer({}).validateSync();
  assert.ok(e.errors.institutionId && e.errors.cohortId && e.errors.studentName && e.errors.companyName);
});
test('PlacementOffer defaults offerType=full_time, status=offered; validates enums', () => {
  const o = new PlacementOffer({ institutionId: oid, cohortId: oid, studentName: 'A', companyName: 'Acme' });
  assert.strictEqual(o.offerType, 'full_time'); assert.strictEqual(o.status, 'offered');
  assert.ok(new PlacementOffer({ institutionId: oid, cohortId: oid, studentName: 'A', companyName: 'X', status: 'nope' }).validateSync().errors.status);
});
test('PlacementOffer keeps ctc + branch', () => {
  const o = new PlacementOffer({ institutionId: oid, cohortId: oid, studentName: 'A', companyName: 'X', ctc: 18, branch: 'CSE', status: 'accepted' });
  assert.strictEqual(o.ctc, 18); assert.strictEqual(o.branch, 'CSE');
});
