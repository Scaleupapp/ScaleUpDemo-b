/**
 * Feature flags driven by environment variables.
 * Strict "true" string match — any other value is false.
 * This keeps rollback to a single env var change.
 */

const FLAGS = {
  FEATURE_DAY1_DIAGNOSTIC: process.env.FEATURE_DAY1_DIAGNOSTIC === 'true',
};

function isEnabled(flag) {
  return !!FLAGS[flag];
}

module.exports = {
  // Legacy flat export — used by diagnosticController.js. Do not remove.
  day1Diagnostic: FLAGS.FEATURE_DAY1_DIAGNOSTIC,
  FLAGS,
  isEnabled,
};
