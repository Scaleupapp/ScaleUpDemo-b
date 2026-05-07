const notificationService = require('../notificationService');

async function notify(userId, planId) {
  try {
    await notificationService.sendToUser(userId, {
      title: 'Your personalized plan is ready',
      body: 'Tap to view your weekly schedule and milestones.',
      data: {
        type: 'plan_ready',
        planId: String(planId),
        deepLink: 'scaleup://plan',
      },
    });
    return { success: true };
  } catch (err) {
    console.error('[planReadyNotificationService] push failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { notify };
