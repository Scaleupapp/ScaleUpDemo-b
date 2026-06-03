// src/test/employer/connectionEmployerRoutes.test.js
'use strict';
const assert = require('assert');
const h = require('../../routes/employer/connections');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function res(){ return { code:200, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  h._svc.expressInterest = async (eid, pid, body) => ({ _id: 'c1', status: 'requested', eid, pid, body });
  await ok('interest 200', async () => {
    const r = res();
    await h.interestHandler({ employer: { employerId: 'e1' }, params: { id: 'p1' }, body: { message: 'hi' } }, r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.data.status, 'requested');
  });
  await ok('interest PROFILE_UNAVAILABLE -> 404', async () => {
    h._svc.expressInterest = async () => { throw new Error('PROFILE_UNAVAILABLE'); };
    const r = res();
    await h.interestHandler({ employer: { employerId: 'e1' }, params: { id: 'pX' }, body: {} }, r);
    assert.strictEqual(r.code, 404);
    assert.strictEqual(r.body.code, 'PROFILE_UNAVAILABLE');
  });
  h._svc.listForEmployer = async () => [{ connectionId: 'c1', status: 'requested' }];
  await ok('connections list 200', async () => {
    const r = res();
    await h.listHandler({ employer: { employerId: 'e1' } }, r);
    assert.strictEqual(r.body.data[0].connectionId, 'c1');
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
