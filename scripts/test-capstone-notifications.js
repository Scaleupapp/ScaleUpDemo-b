#!/usr/bin/env node
'use strict';

/**
 * Fires the two new capstone push notifications to a specific user's
 * device. Lets you verify that the push pipeline (FCM/APNs) works end-to-end
 * without waiting 7 days or grinding through a real capstone session.
 *
 * Both pushes:
 *   - CODING_LEVEL_UP                 — "You leveled up!"
 *   - CODING_CAPSTONE_AVAILABLE       — "Your weekly capstone is ready"
 *
 * Each one is sent via the unified notificationService, which creates an
 * in-app Notification record + best-effort FCM/APNs push.
 *
 * Usage:
 *   node scripts/test-capstone-notifications.js --email nirpeksh@scaleupapp.club
 *   node scripts/test-capstone-notifications.js --user-id 6abc12...
 *   node scripts/test-capstone-notifications.js --email ... --only level_up
 *   node scripts/test-capstone-notifications.js --email ... --only available
 */

require('dotenv').config();
const mongoose = require('mongoose');

const args = (() => {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else { out[key] = true; }
  }
  return out;
})();

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../src/models/User');
  const notificationService = require('../src/services/notificationService');
  const { buildPayload, NOTIFICATION_TYPES } = require('../src/coding/services/codingNotifications');

  let user;
  if (args.email) {
    user = await User.findOne({ email: args.email });
  } else if (args['user-id']) {
    user = await User.findById(args['user-id']);
  } else {
    console.error('Pass --email <email> or --user-id <id>');
    process.exit(1);
  }
  if (!user) {
    console.error('User not found');
    process.exit(1);
  }
  console.log(`Sending to user ${user._id} (${user.email})`);

  const only = args.only || 'both'; // 'level_up' | 'available' | 'both'

  if (only === 'both' || only === 'level_up') {
    const payload = buildPayload(NOTIFICATION_TYPES.CODING_LEVEL_UP, {
      deepLink: 'scaleup://compass/coding',
      from_difficulty: 'easy',
      to_difficulty: 'medium',
      test: true,
    });
    await notificationService.sendToUser(user._id, payload);
    console.log('  ✓ CODING_LEVEL_UP sent');
  }

  if (only === 'both' || only === 'available') {
    const payload = buildPayload(NOTIFICATION_TYPES.CODING_CAPSTONE_AVAILABLE, {
      deepLink: 'scaleup://compass/coding',
      test: true,
    });
    await notificationService.sendToUser(user._id, payload);
    console.log('  ✓ CODING_CAPSTONE_AVAILABLE sent');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
