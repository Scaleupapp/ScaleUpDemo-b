// src/test/employer/employerAuthRoutes.test.js
'use strict';
const assert = require('assert');
const featureFlags = require('../../config/featureFlags');
const h = require('../../routes/employer/auth');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function res(){ return { code:200, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  h._svc.signup = async () => ({ ok: true });
  await ok('signup 200', async () => {
    const r = res();
    await h.signupHandler({ body: { email: 'hr@techco.com', companyName: 'TechCo', name: 'Aarti' } }, r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.success, true);
  });
  await ok('signup WORK_EMAIL_REQUIRED -> 400 code', async () => {
    h._svc.signup = async () => { throw new Error('WORK_EMAIL_REQUIRED'); };
    const r = res();
    await h.signupHandler({ body: { email: 'x@gmail.com' } }, r);
    assert.strictEqual(r.code, 400); assert.strictEqual(r.body.code, 'WORK_EMAIL_REQUIRED');
  });
  h._svc.verifyEmail = async () => ({ jwt: 'jwt123', approvalStatus: 'pending' });
  await ok('verify returns jwt', async () => {
    const r = res();
    await h.verifyHandler({ body: { token: 't' } }, r);
    assert.strictEqual(r.body.data.jwt, 'jwt123');
  });

  await ok('flagGuard returns 404 when employerMarketplace off', async () => {
    const original = featureFlags.employerMarketplace;
    featureFlags.employerMarketplace = false;
    try {
      const r = res();
      let nextCalled = false;
      h.flagGuard({ }, r, () => { nextCalled = true; });
      assert.strictEqual(r.code, 404);
      assert.strictEqual(r.body.success, false);
      assert.strictEqual(nextCalled, false);
    } finally {
      featureFlags.employerMarketplace = original;
    }
  });

  console.log(`# tests 4\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
