const test = require('node:test');
const assert = require('node:assert');
const { sendInvites } = require('../../services/institution/inviteService');

test('sendInvites emails + SMSes each pending student and marks invited', async () => {
  const emails = [], smses = [];
  const email = { sendStudentInvite: async (to, opts) => emails.push({ to, opts }) };
  const sendSMS = async (to, body) => smses.push({ to, body });
  const pending = [
    { email: 'a@x.edu', phone: '+91980', name: 'A', inviteToken: 't1', status: 'pending', save: async function () { this._s = true; } },
    { email: 'b@x.edu', phone: '+91981', name: 'B', inviteToken: 't2', status: 'pending', save: async function () { this._s = true; } },
  ];
  const res = await sendInvites(pending, { institutionName: 'NGIT', baseLink: 'https://app/join', deps: { email, sendSMS } });
  assert.strictEqual(res.invited, 2);
  assert.strictEqual(emails[0].opts.link, 'https://app/join?token=t1');
  assert.strictEqual(smses.length, 2);
  assert.strictEqual(pending[0].status, 'invited');
});

test('sendInvites records a failure without aborting the batch', async () => {
  const email = { sendStudentInvite: async (to) => { if (to === 'bad') throw new Error('smtp'); } };
  const sendSMS = async () => {};
  const pending = [
    { email: 'bad', phone: '+1', inviteToken: 't', status: 'pending', save: async () => {} },
    { email: 'ok@x.edu', phone: '+2', inviteToken: 't', status: 'pending', save: async function () { this.status = 'invited'; } },
  ];
  const res = await sendInvites(pending, { institutionName: 'X', baseLink: 'l', deps: { email, sendSMS } });
  assert.strictEqual(res.failures.length, 1);
  assert.strictEqual(res.invited, 1);
});
