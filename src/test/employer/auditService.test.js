// src/test/employer/auditService.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/marketplaceAuditService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  let written = null;
  svc._write = async (doc) => { written = doc; return doc; };
  await ok('logReveal writes a reveal record', async () => {
    await svc.logReveal({ employerId: 'e1', candidateUserId: 'u1', connectionId: 'c1' });
    assert.strictEqual(written.kind, 'reveal');
    assert.strictEqual(written.actorType, 'employer');
    assert.strictEqual(written.actorId, 'e1');
    assert.strictEqual(written.subjectUserId, 'u1');
  });
  await ok('logView writes a view record', async () => {
    await svc.logView({ employerId: 'e1', talentProfileId: 'p1' });
    assert.strictEqual(written.kind, 'view');
  });
  await ok('never throws when the write fails', async () => {
    svc._write = async () => { throw new Error('db down'); };
    await svc.logInterest({ employerId: 'e1', candidateUserId: 'u1', connectionId: 'c1' }); // must resolve, not reject
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
