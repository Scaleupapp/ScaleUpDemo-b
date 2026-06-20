const test = require('node:test');
const assert = require('node:assert');
const sendSMS = require('../../utils/sendSMS');

test('sendSMS calls the twilio client with from/to/body', async () => {
  const calls = [];
  sendSMS._client = { messages: { create: async (args) => { calls.push(args); return { sid: 'SM1' }; } } };
  process.env.TWILIO_PHONE_NUMBER = '+10000000000';
  const res = await sendSMS('+919800000001', 'hello');
  assert.strictEqual(res.sid, 'SM1');
  assert.strictEqual(calls[0].to, '+919800000001');
  assert.strictEqual(calls[0].from, '+10000000000');
  assert.strictEqual(calls[0].body, 'hello');
});
