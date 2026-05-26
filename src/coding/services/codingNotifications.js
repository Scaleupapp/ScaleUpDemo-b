'use strict';

/**
 * codingNotifications.js
 *
 * Notification type constants, message templates, and payload builder for
 * the coding-practice feature.
 *
 * ── Integration with existing notification system ───────────────────────────
 *
 * The existing dispatcher is src/services/notificationService.js.
 * It creates an in-app Notification document (model: src/models/Notification.js)
 * AND sends a push via FCM / APNs.
 *
 * TWO things need to happen before these types are fully live in production
 * (deferred to a follow-up ops task):
 *
 *   1. src/models/Notification.js — add the 3 new strings to the `type` enum:
 *        'coding_drill_ready',
 *        'coding_calibration_invitation',
 *        'coding_difficulty_change_suggestion'
 *
 *   2. notificationService._mapDataTypeToNotificationType() — add mappings so
 *      the in-app record gets the right type when sent via sendToUser():
 *        coding_drill_ready              → 'coding_drill_ready'
 *        coding_calibration_invitation   → 'coding_calibration_invitation'
 *        coding_difficulty_change_suggestion → 'coding_difficulty_change_suggestion'
 *
 * Usage example (from a future coding-scheduler worker):
 *
 *   const notificationService = require('../../services/notificationService');
 *   const { buildPayload, NOTIFICATION_TYPES } = require('./codingNotifications');
 *
 *   const payload = buildPayload(NOTIFICATION_TYPES.CODING_DRILL_READY, { bundle_id: bundleId });
 *   await notificationService.sendToUser(userId, payload);
 *
 * The calibration invitation should be scheduled at peakHourCalculator(userId)
 * per spec §19: "Tied to user's historical app-open peak hour".
 */

/** @readonly */
const NOTIFICATION_TYPES = Object.freeze({
  /** Daily prompt to take today's drill. */
  CODING_DRILL_READY: 'coding_drill_ready',

  /** Sent once during backfill (T44) to invite the user to calibrate. */
  CODING_CALIBRATION_INVITATION: 'coding_calibration_invitation',

  /** Sent when the recalibrator recommends a difficulty change. */
  CODING_DIFFICULTY_CHANGE_SUGGESTION: 'coding_difficulty_change_suggestion',
});

/** @readonly */
const TEMPLATES = Object.freeze({
  [NOTIFICATION_TYPES.CODING_DRILL_READY]: {
    title: "Today's coding drill is ready",
    body: 'A 10-min drill picked for what you need most. Tap to start.',
  },
  [NOTIFICATION_TYPES.CODING_CALIBRATION_INVITATION]: {
    title: 'New: coding practice for your objective',
    body: 'Take an 8-min calibration to see where you stand.',
  },
  [NOTIFICATION_TYPES.CODING_DIFFICULTY_CHANGE_SUGGESTION]: {
    title: 'Time to step up?',
    body: 'Your recent scores suggest you might be ready for harder drills.',
  },
});

/**
 * Build a notification payload compatible with notificationService.sendToUser().
 *
 * @param {string} type  One of NOTIFICATION_TYPES values
 * @param {object} [data]  Extra fields merged into payload.data
 * @returns {{ type: string, title: string, body: string, data: object }}
 */
function buildPayload(type, data = {}) {
  const tpl = TEMPLATES[type];
  if (!tpl) throw new Error(`Unknown coding notification type: ${type}`);
  return {
    type,
    title: tpl.title,
    body: tpl.body,
    data: {
      category: 'coding',
      ...data,
    },
  };
}

module.exports = { NOTIFICATION_TYPES, TEMPLATES, buildPayload };
