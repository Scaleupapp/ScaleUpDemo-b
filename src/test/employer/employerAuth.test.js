// src/test/employer/employerAuth.test.js
'use strict';
const assert = require('assert');
process.env.JWT_ACCESS_SECRET = 'testsecret';
const jwt = require('jsonwebtoken');
const svc = require('../../services/employer/employerAuthService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  await ok('rejects free email domains', async () => {
    assert.strictEqual(svc.isWorkEmail('someone@gmail.com'), false);
    assert.strictEqual(svc.isWorkEmail('hr@techco.com'), true);
  });

  await ok('rejects free-email subdomain bypass (hr@sub.gmail.com)', async () => {
    assert.strictEqual(svc.isWorkEmail('hr@sub.gmail.com'), false);
    assert.strictEqual(svc.isWorkEmail('hr@techco.com'), true);
  });

  let saved = null, sentToken = null;
  svc._upsertByEmail = async (email, patch) => { saved = { email, patch }; return { _id: 'e1', email, ...patch.set, ...patch.setOnInsert }; };
  svc._sendEmail = async (email, token, kind) => { sentToken = token; return true; };

  await ok('signup stores hashed token + sends', async () => {
    const r = await svc.signup({ email: 'hr@techco.com', companyName: 'TechCo', name: 'Aarti' });
    assert.strictEqual(r.ok, true);
    assert.ok(saved.patch.set.authTokenHash);
    assert.notStrictEqual(saved.patch.set.authTokenHash, sentToken); // stored hashed, not raw
  });

  await ok('signup rejects gmail', async () => {
    await assert.rejects(() => svc.signup({ email: 'x@gmail.com', companyName: 'C', name: 'N' }), /WORK_EMAIL_REQUIRED/);
  });

  await ok('verifyEmail consumes token, verifies, returns JWT (browse)', async () => {
    const acc = { _id: 'e1', email: 'hr@techco.com', approvalStatus: 'pending',
      authTokenHash: svc._hash(sentToken), authTokenExpires: new Date(Date.now() + 60000) };
    svc._findByToken = async () => acc;
    svc._save = async (a) => a;
    const r = await svc.verifyEmail(sentToken);
    assert.ok(r.jwt);
    const dec = jwt.verify(r.jwt, 'testsecret');
    assert.strictEqual(dec.type, 'employer');
    assert.strictEqual(dec.employerId, 'e1');
    assert.strictEqual(acc.emailVerified, true);
    assert.strictEqual(acc.authTokenHash, null); // single-use consumed
  });

  await ok('verifyEmail rejects expired', async () => {
    svc._findByToken = async () => ({ _id: 'e1', authTokenHash: svc._hash('t'), authTokenExpires: new Date(Date.now() - 1000) });
    await assert.rejects(() => svc.verifyEmail('t'), /TOKEN_INVALID/);
  });

  console.log(`# tests 6\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
