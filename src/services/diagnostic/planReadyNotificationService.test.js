const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const notifPath = require.resolve('../notificationService');
const calls = [];
require.cache[notifPath] = {
  exports: {
    sendToUser: async (userId, payload) => {
      calls.push({ userId: String(userId), payload });
      return { success: true };
    },
  },
};

delete require.cache[require.resolve('./planReadyNotificationService')];
const svc = require('./planReadyNotificationService');

test('planReadyNotificationService.notify: sends push with deep link', async () => {
  calls.length = 0;
  const userId = new mongoose.Types.ObjectId();
  const planId = new mongoose.Types.ObjectId();
  const result = await svc.notify(userId, planId);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].userId, String(userId));
  assert.strictEqual(calls[0].payload.title, 'Your personalized plan is ready');
  assert.ok(calls[0].payload.body.toLowerCase().includes('tap'));
  assert.strictEqual(calls[0].payload.data.type, 'plan_ready');
  assert.strictEqual(calls[0].payload.data.planId, String(planId));
  assert.strictEqual(calls[0].payload.data.deepLink, 'scaleup://plan');
  assert.ok(result.success);
});

test('planReadyNotificationService.notify: tolerates push failures gracefully', async () => {
  require.cache[notifPath].exports.sendToUser = async () => { throw new Error('FCM down'); };
  const out = await svc.notify(new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId());
  assert.strictEqual(out.success, false);
  assert.ok(out.error);
});
