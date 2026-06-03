// src/test/employer/auditModel.test.js
'use strict';
const assert = require('assert');
const mongoose = require('mongoose');
const MarketplaceAuditLog = require('../../models/MarketplaceAuditLog');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('kind enum + required actor', () => {
  const a = new MarketplaceAuditLog({ kind: 'reveal', actorType: 'employer', actorId: new mongoose.Types.ObjectId() });
  assert.strictEqual(a.validateSync(), undefined);
});
ok('rejects bad kind', () => {
  const a = new MarketplaceAuditLog({ kind: 'nope', actorType: 'employer', actorId: new mongoose.Types.ObjectId() });
  assert.ok(a.validateSync().errors.kind);
});
ok('rejects bad actorType', () => {
  const a = new MarketplaceAuditLog({ kind: 'view', actorType: 'alien', actorId: new mongoose.Types.ObjectId() });
  assert.ok(a.validateSync().errors.actorType);
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
