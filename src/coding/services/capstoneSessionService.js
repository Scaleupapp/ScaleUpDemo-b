'use strict';

/**
 * capstoneSessionService — extracted capstone session lifecycle helpers.
 *
 * Extracted from capstones.controller.js so engineAdapters.js can call
 * startSession without a circular require, and so both can be tested without
 * DB. All production deps are injected lazily (default-require inside each
 * function) to break the capstones.controller ↔ capstoneSessionService cycle.
 */

/**
 * Abort any never-started sessions for this user (status in
 * scheduled/provisioning/ready, started_at null). Called before every start
 * and retry to prevent phantom "in progress" sessions from piling up.
 *
 * @param {string} userId
 * @param {object} deps  Injectable: CapstoneSession, applyControl
 */
async function abortNeverStartedSessions(userId, deps = {}) {
  const CapstoneSession = deps.CapstoneSession || require('../models/capstoneSession.model');
  // Lazy require to break circular: controller exports applyControl, and is also
  // the consumer of this service. Loading it inside the function body avoids the
  // module-evaluation cycle.
  const applyControl = deps.applyControl || require('../controllers/capstones.controller').applyControl;

  const findQuery = {
    user_id: userId,
    status: { $in: ['scheduled', 'provisioning', 'ready'] },
    started_at: null,
  };
  const findResult = CapstoneSession.find(findQuery);
  // Support both Mongoose query-chain (sync) and Promise-returning test mocks (async).
  const stale = typeof findResult.then === 'function'
    ? await (await findResult).select('_id').lean()
    : await findResult.select('_id').lean();

  for (const s of stale) {
    await applyControl({ sessionId: s._id, userId, action: 'abort' }).catch(() => {});
  }
}

/**
 * Create a new capstone session for the given user + bundle and fire
 * (non-blocking) sandbox provisioning. Does NOT mint a pairing code — the
 * caller is responsible for minting after receiving the session so that
 * the controller and the institution assessment route each mint exactly once.
 *
 * @param {object} args            { userId, bundleId }
 * @param {object} deps            Injectable: ArtifactBundle, CapstoneSession,
 *                                  sandboxOrchestrator, applyControl
 * @returns {{ session, timeBudgetSeconds }}
 */
async function startSession({ userId, bundleId }, deps = {}) {
  const ArtifactBundle = deps.ArtifactBundle || require('../../coding/models/artifactBundle.model');
  const CapstoneSession = deps.CapstoneSession || require('../models/capstoneSession.model');
  const sandboxOrchestrator = deps.sandboxOrchestrator || require('./sandboxOrchestrator');

  const bundle = await ArtifactBundle.findById(bundleId);
  if (!bundle) throw new Error('BUNDLE_NOT_FOUND');
  if (bundle.type !== 'capstone') throw new Error('NOT_A_CAPSTONE');

  await abortNeverStartedSessions(userId, {
    CapstoneSession: deps.CapstoneSession,
    applyControl: deps.applyControl,
  });

  const session = await CapstoneSession.create({
    user_id: userId,
    bundle_id: bundle._id,
    status: 'scheduled',
    time_budget_seconds: bundle.time_budget_minutes * 60,
  });

  // Fire-and-forget — don't make callers wait for sandbox warm-up.
  sandboxOrchestrator.provisionForSession(session._id).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[capstoneSessionService] provision failed:', err.message);
  });

  return { session, timeBudgetSeconds: session.time_budget_seconds };
}

module.exports = { abortNeverStartedSessions, startSession };
