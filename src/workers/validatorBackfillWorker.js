/**
 * validatorBackfillWorker — weekly re-validation of questions stuck in 'pending'.
 *
 * Recommended cron: Mondays 03:00 IST (21:30 UTC Sunday = '30 21 * * 0').
 * As LLM models improve over time, re-running the validator against pending
 * questions can naturally promote them to auto_verified without admin intervention.
 */

const DiagnosticQuestionBank = require('../models/DiagnosticQuestionBank');
const { validateQuestion } = require('../services/diagnostic/questionValidatorService');

const BATCH_SIZE = 50;

async function runBackfill(opts = {}) {
  const dryRun = opts.dryRun || false;
  const batchSize = opts.batchSize || BATCH_SIZE;

  const pending = await DiagnosticQuestionBank.find({
    verificationStatus: 'pending',
  })
    .limit(batchSize)
    .lean();

  if (pending.length === 0) {
    console.log('[validatorBackfillWorker] No pending questions found — nothing to backfill.');
    return { processed: 0, promoted: 0, demoted: 0, unchanged: 0 };
  }

  console.log(`[validatorBackfillWorker] Re-validating ${pending.length} pending questions (dryRun=${dryRun})...`);

  let promoted = 0;
  let demoted = 0;
  let unchanged = 0;

  for (const question of pending) {
    let result;
    try {
      result = await validateQuestion(question);
    } catch (e) {
      console.warn(`[validatorBackfillWorker] Validate error for ${question._id}: ${e.message}`);
      continue;
    }

    const newStatus = result.status;

    if (newStatus === 'pending') {
      unchanged++;
      continue;
    }

    if (!dryRun) {
      await DiagnosticQuestionBank.findByIdAndUpdate(question._id, {
        verificationStatus: newStatus,
        validatorScore: result.score,
        validatorCritique: result.critique,
        validatorIssues: result.issues,
        lastValidatedAt: new Date(),
      });
    }

    if (newStatus === 'auto_verified') {
      promoted++;
      console.log(`[validatorBackfillWorker] Promoted ${question._id} → auto_verified (score ${result.score})`);
    } else {
      demoted++;
      console.log(`[validatorBackfillWorker] Demoted ${question._id} → ${newStatus} (score ${result.score})`);
    }
  }

  const summary = {
    processed: pending.length,
    promoted,
    demoted,
    unchanged,
  };
  console.log('[validatorBackfillWorker] Done.', summary);
  return summary;
}

module.exports = { runBackfill };

if (require.main === module) {
  const mongoose = require('mongoose');
  require('dotenv').config();
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => runBackfill())
    .then(summary => {
      console.log(JSON.stringify(summary, null, 2));
      return mongoose.disconnect();
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
