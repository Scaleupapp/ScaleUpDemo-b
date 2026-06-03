// src/test/employer/connectionRespond.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/connectionService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  await ok('approve sets status + respondedAt when owned + pending', async () => {
    const conn = { _id: 'c1', candidateUserId: 'u1', status: 'requested', save: async function(){ this._saved = true; return this; } };
    svc._loadConnectionById = async () => conn;
    const r = await svc.respond('c1', 'u1', 'approved');
    assert.strictEqual(r.status, 'approved');
    assert.ok(r.respondedAt);
    assert.ok(conn._saved);
  });
  await ok('not owner -> NOT_FOUND', async () => {
    svc._loadConnectionById = async () => ({ _id: 'c1', candidateUserId: 'uOTHER', status: 'requested' });
    await assert.rejects(() => svc.respond('c1', 'u1', 'approved'), /NOT_FOUND/);
  });
  await ok('already responded -> ALREADY_RESPONDED', async () => {
    svc._loadConnectionById = async () => ({ _id: 'c1', candidateUserId: 'u1', status: 'approved' });
    await assert.rejects(() => svc.respond('c1', 'u1', 'declined'), /ALREADY_RESPONDED/);
  });
  await ok('bad decision -> BAD_DECISION', async () => {
    svc._loadConnectionById = async () => ({ _id: 'c1', candidateUserId: 'u1', status: 'requested' });
    await assert.rejects(() => svc.respond('c1', 'u1', 'maybe'), /BAD_DECISION/);
  });
  await ok('listForCandidate maps via candidateView (masked when pending)', async () => {
    svc._findForCandidate = async () => [{ _id: 'c1', status: 'requested', employerId: 'e1', roleContext: 'BE', message: 'hi' }];
    svc._loadEmployer = async () => ({ companyName: 'TechCo', name: 'Aarti', email: 'a@techco.com' });
    const list = await svc.listForCandidate('u1');
    assert.strictEqual(list[0].employer, 'A verified employer');
    assert.ok(!JSON.stringify(list).includes('TechCo'));
  });
  await ok('listForEmployer reveals candidate only when approved', async () => {
    svc._findForEmployer = async () => [
      { _id: 'c1', status: 'requested', talentProfileId: 'p1', candidateUserId: 'u1' },
      { _id: 'c2', status: 'approved', talentProfileId: 'p2', candidateUserId: 'u2' },
    ];
    svc._loadProfile = async (id) => ({ _id: id, snapshot: { roleLabel: 'BE', proofToken: 'T' } });
    svc._loadCandidate = async (id) => ({ firstName: 'Priya', lastName: 'S', email: 'p@x.com', phone: '+91' });
    const list = await svc.listForEmployer('e1');
    assert.strictEqual(list[0].reveal, undefined);          // pending: masked
    assert.strictEqual(list[1].reveal.name, 'Priya S');     // approved: revealed
    assert.ok(!JSON.stringify(list[0]).includes('Priya'));  // no leak on pending
  });
  console.log(`# tests 6\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
