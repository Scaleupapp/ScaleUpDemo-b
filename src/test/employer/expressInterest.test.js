// src/test/employer/expressInterest.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/connectionService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  const profile = { _id: 'p1', userId: 'u1', objectiveId: 'o1', optedIn: true, status: 'active' };
  await ok('creates a request idempotently', async () => {
    svc._loadProfile = async () => profile;
    let upserted = null;
    svc._upsertConnection = async (key, patch) => { upserted = { key, patch }; return { _id: 'c1', ...key, ...patch.$setOnInsert, status: 'requested' }; };
    const r = await svc.expressInterest('e1', 'p1', { message: 'hi', roleContext: 'Backend Engineer' });
    assert.strictEqual(upserted.key.employerId, 'e1');
    assert.strictEqual(upserted.key.candidateUserId, 'u1');
    assert.strictEqual(upserted.key.objectiveId, 'o1');
    assert.strictEqual(upserted.patch.$setOnInsert.message, 'hi');
    assert.strictEqual(r.status, 'requested');
  });
  await ok('profile not in pool -> PROFILE_UNAVAILABLE', async () => {
    svc._loadProfile = async () => null;
    await assert.rejects(() => svc.expressInterest('e1', 'pX', {}), /PROFILE_UNAVAILABLE/);
  });
  await ok('paused profile -> PROFILE_UNAVAILABLE', async () => {
    svc._loadProfile = async () => ({ _id: 'p1', userId: 'u1', optedIn: false, status: 'paused' });
    await assert.rejects(() => svc.expressInterest('e1', 'p1', {}), /PROFILE_UNAVAILABLE/);
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
