'use strict';

/**
 * Generation Pipeline Orchestrator
 *
 * Coordinates: generate → validate → (if fail) regenerate-with-critique
 *              → (after N retries) push to human_review_queue.
 *
 * Public API:
 *   runPipeline(request, options)  — run a full generate+validate cycle
 *   getMetrics()                   — aggregate stats since process start
 *   resetMetrics()                 — reset aggregate stats (used in tests)
 */

const contentGenerator = require('./contentGenerator');
const contentValidator = require('./contentValidator');

// ── In-process metrics state ──────────────────────────────────────────────────

const metricsState = {
  totalRuns: 0,
  passOnFirstTry: 0,
  totalAttempts: 0,
  humanReviewCount: 0,
};

/**
 * Returns a snapshot of aggregate pipeline metrics since process start
 * (or since the last resetMetrics() call).
 *
 * @returns {{ totalRuns, passOnFirstTry, totalAttempts, humanReviewCount, pass_on_first_try_rate }}
 */
function getMetrics() {
  const pass_on_first_try_rate = metricsState.totalRuns === 0
    ? 0
    : metricsState.passOnFirstTry / metricsState.totalRuns;
  return {
    ...metricsState,
    pass_on_first_try_rate,
  };
}

/**
 * Resets all aggregate counters to zero.
 * Primarily used in test teardown.
 */
function resetMetrics() {
  metricsState.totalRuns = 0;
  metricsState.passOnFirstTry = 0;
  metricsState.totalAttempts = 0;
  metricsState.humanReviewCount = 0;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

/**
 * Run the full generation + validation pipeline with retry-and-critique.
 *
 * On each iteration:
 *   1. Call contentGenerator.generate() (passing `critique` on retries).
 *   2. Call contentValidator.validate() on the resulting draft.
 *   3. If ok → return success result.
 *   4. If not ok and retries remain → loop with critique appended.
 *   5. If maxRetries exhausted → push to human review queue and return failure result.
 *
 * @param {{ role_track: string, drill_subtype: string, difficulty: string, language: string, topic_hint?: string }} request
 * @param {{ maxRetries?: number }} [options]
 * @returns {Promise<{ ok: boolean, bundle_id: string, attempts: number, duration_ms: number, errors?: string[] }>}
 */
async function runPipeline(request, options = {}) {
  const { maxRetries = 3 } = options;
  const started = Date.now();
  metricsState.totalRuns += 1;

  let lastDraft = null;
  let lastErrors = [];

  // Total attempts = maxRetries + 1 (1 initial attempt + maxRetries retries)
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    metricsState.totalAttempts += 1;

    // Build generate args — include critique on retry attempts
    const genArgs = { ...request };
    if (attempt > 1 && lastErrors.length > 0) {
      genArgs.critique = `Previous attempt failed validation: ${lastErrors.join('; ')}. Fix these issues.`;
    }

    const draft = await contentGenerator.generate(genArgs);
    lastDraft = draft;

    const validation = await contentValidator.validate({ bundle_id: draft._id });

    if (validation.ok) {
      if (attempt === 1) metricsState.passOnFirstTry += 1;
      return {
        ok: true,
        bundle_id: draft._id,
        attempts: attempt,
        duration_ms: Date.now() - started,
      };
    }

    lastErrors = validation.errors || ['unknown validation failure'];
  }

  // All attempts exhausted — push to human review queue
  await contentValidator.pushToHumanReview({
    bundle_id: lastDraft._id,
    errors: lastErrors,
  });
  metricsState.humanReviewCount += 1;

  return {
    ok: false,
    bundle_id: lastDraft._id,
    attempts: maxRetries + 1,
    errors: lastErrors,
    duration_ms: Date.now() - started,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { runPipeline, getMetrics, resetMetrics };
