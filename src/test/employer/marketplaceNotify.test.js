// src/test/employer/marketplaceNotify.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/marketplaceNotificationService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  let pushed = null;
  svc._sendToUser = async (userId, payload) => { pushed = { userId, payload }; };
  await ok('notifyCandidateOfInterest pushes (no employer identity leaked)', async () => {
    await svc.notifyCandidateOfInterest('u1', { roleContext: 'Backend Engineer' });
    assert.strictEqual(pushed.userId, 'u1');
    assert.ok(/verified employer/i.test(pushed.payload.title + pushed.payload.body));
    assert.ok(!JSON.stringify(pushed.payload).toLowerCase().includes('techco')); // no employer name
    assert.strictEqual(pushed.payload.data.type, 'marketplace_interest');
  });

  let emailed = null;
  svc._loadEmployerEmail = async () => 'hr@techco.com';
  svc._sendEmail = async (to, subject, body) => { emailed = { to, subject, body }; };
  await ok('notifyEmployerOfApproval emails the employer', async () => {
    await svc.notifyEmployerOfApproval('e1', { connectionId: 'c1' });
    assert.strictEqual(emailed.to, 'hr@techco.com');
    assert.ok(/accepted|connect/i.test(emailed.subject + emailed.body));
  });

  await ok('never throws when push fails', async () => {
    svc._sendToUser = async () => { throw new Error('apns down'); };
    await svc.notifyCandidateOfInterest('u1', {}); // resolves
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
