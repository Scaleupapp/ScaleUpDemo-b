'use strict';

/**
 * Capstone Evaluator — top-level entry point.
 *
 * Called from the BullMQ worker (workers/capstoneEval.worker.js) after a
 * session transitions submitted → evaluating. Performs the full async
 * pipeline per spec §7.2 step 10 + §8.2:
 *
 *   1. fetch session + bundle + recording
 *   2. compute diff (starter → final filetree)
 *   3. run final-harness (visible tests + hidden tests + lint)
 *   4. analyse Compass log (AI-pair-effectiveness signal)
 *   5. one Sonnet 4.6 call: full context → six rubric dimensions
 *   6. anchor-drift detection (spec §8.3) — if any anchor diverges > 2pts,
 *      flag for human review + re-run evaluator with stricter prompt
 *   7. persist result, transition session → graded, push notification,
 *      enqueue follow-up Compass-tutor surface
 *
 * All LLM spend tracked via costTracker.recordSpend so we can alert when
 * a session crosses the per-session budget ceiling.
 */

const { evaluate } = require('./pipeline');

module.exports = { evaluate };
