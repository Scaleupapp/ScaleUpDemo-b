/**
 * Feature flags driven by environment variables.
 * Strict "true" string match — any other value is false.
 * This keeps rollback to a single env var change.
 */
module.exports = {
  day1Diagnostic: process.env.FEATURE_DAY1_DIAGNOSTIC === 'true',
};
