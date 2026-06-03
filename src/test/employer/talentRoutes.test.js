// src/test/employer/talentRoutes.test.js
'use strict';
const assert = require('assert');
const h = require('../../routes/v2/talent');
const featureFlags = require('../../config/featureFlags');
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

  // Fix 2: NO_SNAPSHOT must surface as 400, not 500
  await ok('optIn NO_SNAPSHOT -> 400 + code', async () => {
    h._svc.optIn = async () => { throw new Error('NO_SNAPSHOT'); };
    const res = mockRes();
    await h.optInHandler({ user: { userId: 'u1' }, body: {} }, res);
    assert.strictEqual(res.code, 400);
    assert.strictEqual(res.body.code, 'NO_SNAPSHOT');
  });

  // Fix 4: flagGuard returns 404 and does NOT call next when flag is off
  await ok('flagGuard 404 when employerMarketplace off', async () => {
    const origVal = featureFlags.employerMarketplace;
    featureFlags.employerMarketplace = false;
    let nextCalled = false;
    const res = mockRes();
    h.flagGuard({}, res, () => { nextCalled = true; });
    featureFlags.employerMarketplace = origVal;
    assert.strictEqual(res.code, 404);
    assert.strictEqual(nextCalled, false);
  });

  console.log(`# tests 4\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
