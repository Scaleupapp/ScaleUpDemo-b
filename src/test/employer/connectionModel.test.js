// src/test/employer/connectionModel.test.js
'use strict';
const assert = require('assert');
const mongoose = require('mongoose');
const ConnectionRequest = require('../../models/ConnectionRequest');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }
const oid = () => new mongoose.Types.ObjectId();

ok('defaults to requested', () => {
  const c = new ConnectionRequest({ employerId: oid(), candidateUserId: oid(), talentProfileId: oid(), objectiveId: oid() });
  assert.strictEqual(c.status, 'requested');
});
ok('status enum rejects junk', () => {
  const c = new ConnectionRequest({ employerId: oid(), candidateUserId: oid(), talentProfileId: oid(), objectiveId: oid(), status: 'nope' });
  assert.ok(c.validateSync().errors.status);
});
ok('required parties', () => {
  const c = new ConnectionRequest({});
  const e = c.validateSync().errors;
  assert.ok(e.employerId && e.candidateUserId && e.talentProfileId);
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
