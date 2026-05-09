/**
 * diagnosticHealthCheckWorker — daily observability for the V2 diagnostic
 * engine prerequisites. Surfaces:
 *   - active UserObjective count
 *   - count missing topicSelfRatings (would self-heal or block)
 *   - count with empty specifics (genuinely blocked, need re-onboarding)
 *
 * Logged via console.warn when any threshold is exceeded so logs/Mixpanel
 * pick it up; emits a `diagnostic.health_check` telemetry event with the
 * raw counts on every run.
 *
 * Recommended cron: daily 04:00 IST (22:30 UTC) — after the validator
 * backfill window so any taxonomy generation has stabilised.
 */

const UserObjective = require('../models/UserObjective');
const telemetry = require('../services/diagnosticTelemetryService');

// Threshold below which we don't bother warning (small numbers are noise).
const WARN_AT_OR_ABOVE = 5;

async function run() {
  const totalActive = await UserObjective.countDocuments({ status: 'active' });

  const missingRatings = await UserObjective.countDocuments({
    status: 'active',
    $or: [
      { topicSelfRatings: { $exists: false } },
      { topicSelfRatings: null },
      { $expr: { $eq: [{ $size: { $ifNull: [{ $objectToArray: '$topicSelfRatings' }, []] } }, 0] } },
    ],
  });

  // "Empty specifics" = no targetRole, targetSkill, examName, or targetCompany.
  // Mongoose stores these under `specifics`; we treat all missing/null/empty
  // string values as absent.
  const emptySpecifics = await UserObjective.countDocuments({
    status: 'active',
    $expr: {
      $eq: [
        { $size: {
            $filter: {
              input: { $ifNull: [{ $objectToArray: '$specifics' }, []] },
              cond: { $and: [
                { $ne: ['$$this.v', null] },
                { $ne: ['$$this.v', ''] },
              ] },
            },
        } },
        0,
      ],
    },
  });

  const summary = {
    totalActive,
    missingRatings,
    emptySpecifics,
    healthy: totalActive - missingRatings,
  };

  telemetry.logEvent('diagnostic.health_check', summary);

  if (missingRatings >= WARN_AT_OR_ABOVE) {
    console.warn(
      `[diagnosticHealthCheckWorker] ${missingRatings}/${totalActive} active objectives missing topicSelfRatings ` +
      `(${emptySpecifics} have empty specifics — will need re-onboarding rather than backfill). ` +
      `Run scripts/migrate/backfillTopicSelfRatings.js to recover the recoverable ones.`,
    );
  } else {
    console.log(`[diagnosticHealthCheckWorker] OK — ${summary.healthy}/${totalActive} active objectives healthy.`);
  }

  return summary;
}

module.exports = { run, WARN_AT_OR_ABOVE };

if (require.main === module) {
  const mongoose = require('mongoose');
  require('dotenv').config();
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => run())
    .then(s => { console.log(JSON.stringify(s, null, 2)); return mongoose.disconnect(); })
    .catch(err => { console.error(err); process.exit(1); });
}
