// src/test/employer/connectionCandidateRoutes.test.js
'use strict';
const assert = require('assert');
const h = require('../../routes/v2/talentConnections');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function res(){ return { code:200, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  h._svc.listForCandidate = async () => [{ connectionId: 'c1', employer: 'A verified employer', status: 'requested' }];
  await ok('inbox 200 + masked', async () => {
    const r = res();
    await h.inboxHandler({ user: { userId: 'u1' } }, r);
    assert.strictEqual(r.body.data[0].employer, 'A verified employer');
  });
  h._svc.respond = async (cid, uid, dec) => ({ _id: cid, status: dec });
  await ok('approve 200', async () => {
    const r = res();
    await h.approveHandler({ user: { userId: 'u1' }, params: { id: 'c1' } }, r);
    assert.strictEqual(r.body.data.status, 'approved');
  });
  await ok('decline 200', async () => {
    const r = res();
    await h.declineHandler({ user: { userId: 'u1' }, params: { id: 'c1' } }, r);
    assert.strictEqual(r.body.data.status, 'declined');
  });
  await ok('respond NOT_FOUND -> 404', async () => {
    h._svc.respond = async () => { throw new Error('NOT_FOUND'); };
    const r = res();
    await h.approveHandler({ user: { userId: 'u1' }, params: { id: 'cX' } }, r);
    assert.strictEqual(r.code, 404);
  });
  await ok('respond ALREADY_RESPONDED -> 409', async () => {
    h._svc.respond = async () => { throw new Error('ALREADY_RESPONDED'); };
    const r = res();
    await h.declineHandler({ user: { userId: 'u1' }, params: { id: 'c1' } }, r);
    assert.strictEqual(r.code, 409);
  });
  console.log(`# tests 5\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
