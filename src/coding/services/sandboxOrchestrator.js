'use strict';

const { getSandboxAdapter } = require('./sandbox/adapterFactory');
const CapstoneSession = require('../models/capstoneSession.model');
const ArtifactBundle = require('../models/artifactBundle.model');
const stateMachine = require('./sessionStateMachine');
const alerts = require('./alerts');

/**
 * Sandbox orchestrator — the single seam between session lifecycle and the
 * underlying sandbox provider (e2b today, possibly Daytona later).
 *
 * Responsibilities:
 *   - Provision a fresh sandbox for a session (load starter repo, set
 *     env, apply limits), flip session to `ready` on success.
 *   - Tear down on submit / abort.
 *   - Surface metrics for the heartbeat emitter (WS2.6).
 *   - Manage a small warm pool so peak-hour cold-start is sub-second.
 *
 * The warm pool implementation here is intentionally simple — a single
 * Map keyed by image template. WS2.9 sandbox-gc worker periodically tops
 * it up. We don't try to load-balance regions or do anything fancy.
 *
 * Spec §9.5: managed first; this whole file is the bridge.
 */

const adapter = getSandboxAdapter();

/**
 * Warm pool target sizes per image. Tuned to ~10–15 concurrent capstone
 * starts per peak hour — fork-bomb crashes reap a sandbox so a 3-deep
 * pool gives us ~2 immediate replacements before we hit cold-start.
 *
 * Override at runtime via env (CAPSTONE_WARM_POOL_<image>=N).
 */
const DEFAULT_POOL_TARGETS = {
  python: 1,
  javascript: 1,
  typescript: 1,
  java: 0, // capstones rarely use Java; cold-start is fine
  sql: 0,
};

/** image → array of { sandboxId, hostUrl, providerToken? } ready to claim */
const pool = new Map();

function poolTarget(image) {
  const override = process.env[`CAPSTONE_WARM_POOL_${image.toUpperCase()}`];
  if (override != null) return Math.max(0, parseInt(override, 10) || 0);
  return DEFAULT_POOL_TARGETS[image] ?? 0;
}

function poolSize(image) {
  return pool.get(image)?.length || 0;
}

/**
 * Tries to claim an existing warm sandbox for this image. Returns null on
 * miss — caller falls through to a fresh provision.
 */
function claimWarmSandbox(image) {
  const list = pool.get(image);
  if (!list || list.length === 0) return null;
  return list.shift();
}

/**
 * Top up the warm pool toward its target. Called by WS2.9 worker on a
 * loop — kept in-service so it shares the adapter instance + can be
 * tested without spinning the worker.
 */
async function topUpPool() {
  const results = { provisioned: 0, failed: 0 };
  for (const [image, target] of Object.entries(DEFAULT_POOL_TARGETS)) {
    if (poolTarget(image) === 0) continue;
    while (poolSize(image) < poolTarget(image)) {
      try {
        const provisioned = await adapter.provision({
          image,
          files: [],
          env: {},
          limits: { wallClockMs: 90 * 60 * 1000 },
        });
        if (!pool.has(image)) pool.set(image, []);
        pool.get(image).push({
          sandboxId: provisioned.sandboxId,
          hostUrl: provisioned.hostUrl,
          warmedAt: new Date(),
        });
        results.provisioned += 1;
      } catch (err) {
        results.failed += 1;
        // Don't loop forever on persistent failure — break this image's row.
        // eslint-disable-next-line no-console
        console.warn(`[sandboxOrchestrator] warm pool top-up failed for ${image}:`, err.message);
        break;
      }
    }
  }
  return results;
}

/**
 * Provision a sandbox for a session: pulls the bundle, materializes the
 * starter_repo, attempts a warm-pool claim, flips session to `ready` on
 * success or `aborted` on failure.
 *
 * @param {import('mongoose').Types.ObjectId|string} sessionId
 * @returns {Promise<{ sandboxId: string, hostUrl?: string }>}
 */
async function provisionForSession(sessionId) {
  const session = await CapstoneSession.findById(sessionId);
  if (!session) throw new Error(`CapstoneSession ${sessionId} not found`);

  const bundle = await ArtifactBundle.findById(session.bundle_id).lean();
  if (!bundle) throw new Error(`ArtifactBundle ${session.bundle_id} not found`);
  if (bundle.type !== 'capstone') {
    throw new Error(`Bundle ${bundle._id} is not a capstone (type=${bundle.type})`);
  }

  // Move to provisioning so the mobile poll sees the right state.
  await stateMachine.transition(sessionId, 'provisioning');

  let sandboxId;
  let hostUrl;
  try {
    const starterFiles = bundle.starter_repo?.files ?? [];
    const warm = claimWarmSandbox(bundle.language);
    if (warm) {
      // Warm sandbox needs the starter repo uploaded (warm pool keeps
      // them empty). Same network round-trip cost as provisioning, but
      // we save the container start time.
      sandboxId = warm.sandboxId;
      hostUrl = warm.hostUrl;
      if (starterFiles.length > 0) {
        await adapter.uploadFiles(sandboxId, starterFiles);
      }
    } else {
      const provisioned = await adapter.provision({
        image: bundle.language,
        files: starterFiles,
        env: {},
        limits: { wallClockMs: bundle.time_budget_minutes * 60 * 1000 + 5 * 60 * 1000 },
      });
      sandboxId = provisioned.sandboxId;
      hostUrl = provisioned.hostUrl;
    }

    // Anti-cheat gate: confirm the custom template's iptables lockdown
    // ran. If E2B_REQUIRE_EGRESS_LOCKDOWN=true and the marker is absent,
    // destroy the sandbox and fail the session — better to abort than
    // let a learner work in an unrestricted environment.
    if (process.env.E2B_REQUIRE_EGRESS_LOCKDOWN === 'true' &&
        typeof adapter.verifyEgressLockdown === 'function') {
      const verdict = await adapter.verifyEgressLockdown(sandboxId);
      if (!verdict.locked) {
        // eslint-disable-next-line no-console
        console.error(`[sandboxOrchestrator] egress lockdown NOT applied on ${sandboxId} — aborting`);
        await alerts.fire({
          category: 'sandbox.egress-not-locked',
          severity: 'error',
          title: `Sandbox booted WITHOUT egress lockdown (sandbox=${sandboxId})`,
          detail: 'The custom template marker /var/lib/scaleup/egress-locked was missing. Check that E2B_TEMPLATE_<LANG> env vars point at the scaleup-*-locked templates and the templates were pushed.',
          dedupKey: 'lockdown-missing',
          fields: { session_id: String(sessionId), sandbox_id: sandboxId },
        });
        await adapter.destroy(sandboxId).catch(() => {});
        throw new Error('sandbox_egress_not_locked');
      }
    }
  } catch (err) {
    // Provisioning failed — mark session aborted so the user can retry
    // (creates a new session). We don't auto-retry: provision failures
    // are typically e2b outages or quota issues that need human eyes.
    await stateMachine.transition(sessionId, 'aborted', { sandbox_id: null }).catch(() => {
      // If even the transition fails, log and re-throw the original.
      // eslint-disable-next-line no-console
      console.error(`[sandboxOrchestrator] provision failed for ${sessionId}:`, err);
    });
    throw err;
  }

  await stateMachine.transition(sessionId, 'ready', {
    sandbox_id: sandboxId,
    sandbox_host_url: hostUrl,
  });

  return { sandboxId, hostUrl };
}

/**
 * Tear down a session's sandbox. Idempotent — calling on a session
 * without a sandbox_id is a no-op. Doesn't change session status (the
 * caller is responsible for that transition).
 */
async function teardownForSession(sessionId) {
  const session = await CapstoneSession.findById(sessionId).lean();
  if (!session || !session.sandbox_id) return;
  try {
    await adapter.destroy(session.sandbox_id);
  } catch (err) {
    // Already gone is fine; surface anything else.
    // eslint-disable-next-line no-console
    console.warn(`[sandboxOrchestrator] destroy failed for ${session.sandbox_id}:`, err.message);
  }
}

/**
 * Heartbeat fuel — pulls live metrics from the sandbox. Returns nulls if
 * the sandbox is gone (caller renders ?'s).
 */
async function getSessionMetrics(sessionId) {
  const session = await CapstoneSession.findById(sessionId).lean();
  if (!session || !session.sandbox_id) return { cpuPct: null, memMb: null };
  try {
    return await adapter.getMetrics(session.sandbox_id);
  } catch {
    return { cpuPct: null, memMb: null };
  }
}

/** Run a command in the session's sandbox. Wraps adapter.runCommand. */
async function runInSession(sessionId, cmd, opts) {
  const session = await CapstoneSession.findById(sessionId).lean();
  if (!session || !session.sandbox_id) {
    throw new Error('Session has no active sandbox');
  }
  return adapter.runCommand(session.sandbox_id, cmd, opts);
}

module.exports = {
  provisionForSession,
  teardownForSession,
  getSessionMetrics,
  runInSession,
  topUpPool,
  claimWarmSandbox,
  poolSize,
  // re-export adapter for code that legitimately needs raw access (compass
  // coder file ops). Most callers should use the higher-level helpers.
  _adapter: adapter,
};
