// src/test/employer/talentRoutes.test.js
'use strict';
const assert = require('assert');
const h = require('../../routes/v2/talent');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function mockRes(){ return { code:200, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  h._svc.optIn = async (uid, prefs) => ({ ok: true, uid, prefs });
  await ok('optIn handler 200', async () => {
    const res = mockRes();
    await h.optInHandler({ user: { userId: 'u1' }, body: { city: 'Pune' } }, res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.success, true);
  });
  await ok('optIn NOT_ELIGIBLE -> 400 + code', async () => {
    h._svc.optIn = async () => { throw new Error('NOT_ELIGIBLE'); };
    const res = mockRes();
    await h.optInHandler({ user: { userId: 'u1' }, body: {} }, res);
    assert.strictEqual(res.code, 400);
    assert.strictEqual(res.body.code, 'NOT_ELIGIBLE');
  });
  console.log(`# tests 2\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
