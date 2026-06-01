/**
 * Feature flags driven by environment variables.
 * Strict "true" string match — any other value is false.
 * This keeps rollback to a single env var change.
 */

const FLAGS = {
  FEATURE_DAY1_DIAGNOSTIC: process.env.FEATURE_DAY1_DIAGNOSTIC === 'true',
  // Readiness redesign: when off (default) the composite runs in SHADOW (logged +
  // persisted) but the legacy value is served. Flip to 'true' to serve composite.
  FEATURE_COMPOSITE_READINESS: process.env.FEATURE_COMPOSITE_READINESS === 'true',
};

function isEnabled(flag) {
  return !!FLAGS[flag];
}

module.exports = {
  // Legacy flat export — used by diagnosticController.js. Do not remove.
  day1Diagnostic: FLAGS.FEATURE_DAY1_DIAGNOSTIC,
  compositeReadiness: FLAGS.FEATURE_COMPOSITE_READINESS,
  FLAGS,
  isEnabled,
};
