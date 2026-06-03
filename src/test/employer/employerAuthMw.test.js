// src/test/employer/employerAuthMw.test.js
'use strict';
const assert = require('assert');
process.env.JWT_ACCESS_SECRET = 'testsecret';
const jwt = require('jsonwebtoken');
const mw = require('../../middleware/employerAuth');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function res(){ return { code:0, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  mw._loadAccount = async (id) => ({ _id: id, emailVerified: true, approvalStatus: 'pending' });

  await ok('valid employer token -> req.employer set', async () => {
    const token = jwt.sign({ employerId: 'e1', type: 'employer' }, 'testsecret');
    const req = { headers: { authorization: `Bearer ${token}` } }; let nexted = false;
    await mw.employerAuth(req, res(), () => { nexted = true; });
    assert.ok(nexted);
    assert.strictEqual(req.employer.employerId, 'e1');
    assert.strictEqual(req.employer.approvalStatus, 'pending');
  });

  await ok('learner token (no type) rejected 401', async () => {
    const token = jwt.sign({ userId: 'u1' }, 'testsecret');
    const r = res(); let nexted = false;
    await mw.employerAuth({ headers: { authorization: `Bearer ${token}` } }, r, () => { nexted = true; });
    assert.strictEqual(nexted, false);
    assert.strictEqual(r.code, 401);
  });

  await ok('requireContactTier blocks pending 403', async () => {
    const r = res(); let nexted = false;
    mw.requireContactTier({ employer: { approvalStatus: 'pending' } }, r, () => { nexted = true; });
    assert.strictEqual(nexted, false);
    assert.strictEqual(r.code, 403);
  });
  await ok('requireContactTier allows approved', async () => {
    let nexted = false;
    mw.requireContactTier({ employer: { approvalStatus: 'approved' } }, res(), () => { nexted = true; });
    assert.ok(nexted);
  });

  console.log(`# tests 4\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
