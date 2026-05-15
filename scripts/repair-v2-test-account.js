/**
 * One-off repair for the v2 test account (claudetest_1778774728@scaleuptest.club).
 *
 * The account was onboarded on pre-fix builds, so it's in a half-broken state:
 *   - diagnosticComplete is null  → relaunch drops the user back into the
 *     diagnostic welcome (#10)
 *   - the active plan's quiz tasks reference quizzes owned by other users,
 *     so they 404 on open (#7)
 *
 * This script: flips diagnosticComplete, deactivates the stale plan, and
 * re-enqueues plan generation against the latest completed diagnostic so a
 * fresh, correct plan is built (with the deployed resolveTopic fix).
 *
 * Safe to re-run. Run via the "Run DB Migration" workflow.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const USER_EMAIL = 'claudetest_1778774728@scaleuptest.club';

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../src/models/User');
  const DiagnosticAttempt = require('../src/models/DiagnosticAttempt');
  const Plan = require('../src/models/Plan');
  const { planGenerationQueue } = require('../src/config/queue');

  const user = await User.findOne({ email: USER_EMAIL });
  if (!user) {
    console.error('[repair] user not found:', USER_EMAIL);
    process.exit(1);
  }
  console.log('[repair] user:', String(user._id));

  // 1. Fix the re-onboarding loop.
  await User.updateOne({ _id: user._id }, { $set: { diagnosticComplete: true } });
  console.log('[repair] diagnosticComplete -> true');

  // 2. Rebuild the plan so quiz tasks reference quizzes this user owns.
  const attempt = await DiagnosticAttempt.findOne({ userId: user._id, status: 'completed' })
    .sort({ completedAt: -1 });
  if (!attempt) {
    console.warn('[repair] no completed diagnostic attempt — skipping plan rebuild');
  } else {
    await Plan.updateMany({ userId: user._id, isActive: true }, { $set: { isActive: false } });
    await DiagnosticAttempt.updateOne({ _id: attempt._id }, { $set: { planGenerationStatus: 'generating' } });
    await planGenerationQueue.add(
      'generate',
      { attemptId: String(attempt._id) },
      { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 50 }
    );
    console.log('[repair] re-enqueued plan generation for attempt', String(attempt._id));
  }

  await mongoose.disconnect();
  console.log('[repair] done');
  process.exit(0);
})().catch((err) => {
  console.error('[repair] failed:', err);
  process.exit(1);
});
