const notificationService = require('../services/notificationService');

/**
 * BullMQ processor for the 'notifications' queue.
 * Each job contains { userId, title, body, data }.
 */
async function processNotification(job) {
  const { userId, title, body, data } = job.data;

  if (!userId || !title) {
    console.warn(`[NotificationWorker] Job ${job.id} missing userId or title, skipping`);
    return;
  }

  console.log(`[NotificationWorker] Sending notification to ${userId}: "${title}"`);
  await notificationService.sendToUser(userId, { title, body, data });
  console.log(`[NotificationWorker] Job ${job.id} completed`);
}

module.exports = processNotification;
