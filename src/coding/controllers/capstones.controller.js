'use strict';

const jwt = require('jsonwebtoken');
const CapstoneSession = require('../models/capstoneSession.model');
const ArtifactBundle = require('../models/artifactBundle.model');
const pairingService = require('../services/pairingService');
const sandboxOrchestrator = require('../services/sandboxOrchestrator');
const recordingService = require('../services/recordingService');
const stateMachine = require('../services/sessionStateMachine');
const sessionRoom = require('../websocket/sessionRoom');
const capstoneEvalWorker = require('../workers/capstoneEval.worker');
const snapshotService = require('../services/snapshotService');

/**
 * Capstone REST controllers. Wire shape lives in openapi.yaml under
 * /api/coding/capstones/*; this file does only HTTP↔service translation.
 *
 * Each handler is a thin function — argument validation is mostly delegated
 * to the model + service layer (Joi-style validators are added in WS2.10
 * tests; for now we surface friendly errors when a required field is
 * obviously missing).
 */

/** GET /api/coding/capstones/library */
async function listLibrary(req, res) {
  const { difficulty, role_track } = req.query;
  const filter = { type: 'capstone', status: 'active' };
  if (difficulty) filter.difficulty = difficulty;
  if (role_track) filter.role_track = role_track;

  const bundles = await ArtifactBundle.find(filter)
    .select('_id brief difficulty role_track time_budget_minutes language stack_variant interview_parallel')
    .lean();

  // Per-user completion lookup — one query, then in-memory join.
  const sessions = await CapstoneSession.find({
    user_id: req.user.userId,
    status: 'graded',
  }).select('bundle_id').lean();
  const completedSet = new Set(sessions.map((s) => String(s.bundle_id)));

  res.json({
    capstones: bundles.map((b) => ({
      bundle_id: String(b._id),
      brief: b.brief,
      difficulty: b.difficulty,
      role_track: b.role_track,
      time_budget_minutes: b.time_budget_minutes,
      language: b.language,
      stack_variant: b.stack_variant,
      interview_parallel: b.interview_parallel,
      already_completed: completedSet.has(String(b._id)),
    })),
  });
}

/** POST /api/coding/capstones/start */
async function start(req, res) {
  const { bundle_id } = req.body || {};
  if (!bundle_id) return res.status(400).json({ error: 'bundle_id required' });

  const bundle = await ArtifactBundle.findById(bundle_id).lean();
  if (!bundle) return res.status(404).json({ error: 'bundle_not_found' });
  if (bundle.type !== 'capstone') return res.status(404).json({ error: 'not_a_capstone' });

  const session = await CapstoneSession.create({
    user_id: req.user.userId,
    bundle_id: bundle._id,
    status: 'scheduled',
    time_budget_seconds: bundle.time_budget_minutes * 60,
  });

  const { code, expiresAt } = await pairingService.mintCode({
    userId: req.user.userId,
    sessionId: session._id,
  });

  // Async provision — don't make mobile wait. Status poll surfaces ready.
  sandboxOrchestrator.provisionForSession(session._id).catch((err) => {
    // Logged inside orchestrator; here we just make sure the error doesn't
    // float up as unhandled.
    // eslint-disable-next-line no-console
    console.warn('[capstones.start] provision failed:', err.message);
  });

  res.status(201).json({
    session_id: String(session._id),
    status: session.status,
    pairing_code: code,
    expires_at: expiresAt,
    time_budget_seconds: session.time_budget_seconds,
  });
}

/** POST /api/coding/capstones/redeem */
async function redeemPairing(req, res) {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });

  const result = await pairingService.redeem(code);
  if (result.kind !== 'ok') {
    return res.status(404).json({
      error: `pairing_code_${result.kind}`, // pairing_code_invalid | _expired | _used
    });
  }

  const session = await CapstoneSession.findById(result.sessionId);
  if (!session) return res.status(404).json({ error: 'pairing_code_invalid' });

  const bundle = await ArtifactBundle.findById(session.bundle_id).lean();
  if (!bundle) return res.status(404).json({ error: 'bundle_not_found' });

  // Short-lived WS token scoped to this session. Expires in 12 hours —
  // longer than a capstone session itself so reconnects work.
  const token = jwt.sign(
    { userId: String(result.userId), sessionId: String(session._id) },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '12h' }
  );

  const wsHost = process.env.WS_PUBLIC_URL || process.env.API_PUBLIC_URL || 'wss://api.scaleupapp.club';
  const wsUrl = `${wsHost.replace(/^http/, 'ws')}/ws/coding?sessionId=${session._id}&token=${token}&role=laptop`;

  res.json({
    session_id: String(session._id),
    ws_url: wsUrl,
    token,
    bundle: projectBundle(bundle),
  });
}

/** GET /api/coding/capstones/:session_id/status */
async function getStatus(req, res) {
  const session = await CapstoneSession.findOne({
    _id: req.params.session_id,
    user_id: req.user.userId,
  }).lean();
  if (!session) return res.status(404).json({ error: 'session_not_found' });

  const bundle = await ArtifactBundle.findById(session.bundle_id).lean();

  res.json({
    session_id: String(session._id),
    status: session.status,
    sandbox_host_url: session.sandbox_host_url || undefined,
    bundle: bundle ? projectBundle(bundle) : undefined,
    started_at: session.started_at,
    time_budget_seconds: session.time_budget_seconds,
    paused_total_seconds: session.paused_total_seconds || 0,
    counters: session.counters || {},
  });
}

/** POST /api/coding/capstones/:session_id/control */
async function control(req, res) {
  const { action } = req.body || {};
  if (!['pause', 'resume', 'abort', 'submit'].includes(action)) {
    return res.status(400).json({ error: 'invalid_action' });
  }
  try {
    const result = await applyControl({
      sessionId: req.params.session_id,
      userId: req.user.userId,
      action,
    });
    res.json({
      session_id: String(result._id),
      status: result.status,
      sandbox_host_url: result.sandbox_host_url || undefined,
      started_at: result.started_at,
      time_budget_seconds: result.time_budget_seconds,
      paused_total_seconds: result.paused_total_seconds || 0,
      counters: result.counters || {},
    });
  } catch (err) {
    if (err instanceof stateMachine.InvalidTransitionError) {
      return res.status(409).json({ error: 'invalid_transition', current_status: err.from });
    }
    throw err;
  }
}

/**
 * Shared control-action implementation. Used by the HTTP controller above
 * AND by sessionRoom's WS `session.control` handler.
 *
 * Side effects per action:
 *   pause   → state machine to `paused`
 *   resume  → state machine to `in_progress` (accumulates paused time)
 *   abort   → state machine to `aborted` + sandbox teardown
 *   submit  → state machine to `submitted` + finalize recording +
 *             sandbox teardown + enqueue evaluator job (lazy — controllers
 *             will own the evaluator queue in WS4)
 *
 * @param {{ sessionId: string, userId?: string, action: string }} args
 */
async function applyControl({ sessionId, userId, action }) {
  // Authorization: when called from HTTP we filter on user; from the WS
  // layer userId is omitted (already verified at connect time).
  const filter = { _id: sessionId };
  if (userId) filter.user_id = userId;
  const session = await CapstoneSession.findOne(filter);
  if (!session) {
    const err = new Error('session_not_found');
    err.status = 404;
    throw err;
  }

  // Map action → target status. The state machine validates legality.
  let target;
  switch (action) {
    case 'pause':  target = 'paused'; break;
    case 'resume': target = 'in_progress'; break;
    case 'abort':  target = 'aborted'; break;
    case 'submit': target = 'submitted'; break;
    default:
      throw new Error(`unknown action ${action}`);
  }

  const updated = await stateMachine.transition(sessionId, target);

  // Post-transition side effects.
  if (target === 'submitted') {
    // Capture a final snapshot BEFORE recording finalize + sandbox
    // teardown so the evaluator + replay have the last-known filetree
    // even if the eval job is delayed (sandbox would otherwise be
    // reaped before pullFinalFiles can read it).
    await snapshotService.captureForSession(sessionId).catch(() => {});
  }
  if (target === 'aborted' || target === 'submitted') {
    await recordingService.finalize(sessionId).catch(() => {});
    await sandboxOrchestrator.teardownForSession(sessionId).catch(() => {});
  }
  // Submitted sessions need to be graded — enqueue the evaluator job.
  // jobId on the queue is keyed by sessionId so a duplicate submit (e.g.
  // a network-retry that wins the state-machine race against the auto-
  // expire path) doesn't double-grade.
  if (target === 'submitted') {
    await capstoneEvalWorker
      .enqueueEvaluation(sessionId)
      .catch((err) => {
        // Don't fail the submit if Redis is briefly unavailable; the
        // sandbox-gc worker has a fallback that re-enqueues stuck
        // submitted sessions next tick.
        // eslint-disable-next-line no-console
        console.warn('[capstones.control] enqueue eval failed:', err.message);
      });
  }

  sessionRoom.publishLifecycle(sessionId, updated.status);

  return updated;
}

/**
 * POST /api/coding/capstones/:session_id/events
 *
 * Browser-side recording client posts batched events here. Each event is
 * normalised against the recordingService catalogue (file_write,
 * file_read, command_run, test_result, compass_turn, tab_blur, paste,
 * focus_change). Unknown event types are dropped silently — the client
 * may emit new types ahead of a backend bump and we don't want to break
 * the IDE for it.
 *
 * Cap of 200 events per batch — protects against a runaway client.
 */
async function appendEvents(req, res) {
  const { events } = req.body || {};
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events array required' });

  // Verify session ownership before accepting any event.
  const session = await CapstoneSession.findOne({
    _id: req.params.session_id,
    user_id: req.user.userId,
  })
    .select('_id status')
    .lean();
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (!['ready', 'in_progress', 'paused'].includes(session.status)) {
    // Events from a terminal-state session are useless — accept-and-drop
    // so the client doesn't see a hard failure on the trailing flush.
    return res.status(202).json({ accepted: 0, reason: 'session not active' });
  }

  const limited = events.slice(0, 200);
  let accepted = 0;
  for (const evt of limited) {
    if (!evt || typeof evt.type !== 'string') continue;
    recordingService.emit(session._id, { type: evt.type, payload: evt.payload || {} });
    accepted += 1;
  }
  res.json({ accepted });
}

/**
 * POST /api/coding/capstones/:session_id/run
 *
 * Run a shell command in the session's sandbox. Web IDE terminal panel
 * calls this. Hard cap on cmd length (4096 chars) + 30 s wall-clock.
 */
async function runInSandbox(req, res) {
  const { cmd } = req.body || {};
  if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > 4096) {
    return res.status(400).json({ error: 'cmd required (string, 1..4096 chars)' });
  }
  const session = await CapstoneSession.findOne({
    _id: req.params.session_id,
    user_id: req.user.userId,
  })
    .select('_id status sandbox_id')
    .lean();
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (!['ready', 'in_progress', 'paused'].includes(session.status)) {
    return res.status(409).json({ error: 'session_not_active', current_status: session.status });
  }
  if (!session.sandbox_id) {
    return res.status(409).json({ error: 'sandbox_not_provisioned' });
  }

  try {
    const r = await sandboxOrchestrator.runInSession(session._id, cmd, { timeoutMs: 30_000 });
    recordingService.emit(session._id, {
      type: 'command_run',
      payload: {
        cmd: cmd.slice(0, 256),
        exit: r.exitCode,
        duration_ms: r.durationMs,
        by: 'learner',
      },
    });
    res.json({
      stdout: (r.stdout || '').slice(0, 16_000),
      stderr: (r.stderr || '').slice(0, 8_000),
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    });
  } catch (err) {
    res.status(500).json({ error: 'sandbox_error', message: err.message });
  }
}

/**
 * POST /api/coding/capstones/:session_id/files
 *
 * Persist a batch of file edits from the web IDE into the session sandbox.
 * Client-side debounce should batch keystrokes; this endpoint enforces a
 * hard cap of 50 files per call + 512 KB total to bound abuse.
 */
async function persistFiles(req, res) {
  const { files } = req.body || {};
  if (!Array.isArray(files)) return res.status(400).json({ error: 'files array required' });
  if (files.length > 50) return res.status(400).json({ error: 'too many files in one batch' });

  const totalBytes = files.reduce(
    (s, f) => s + (typeof f?.content === 'string' ? f.content.length : 0),
    0
  );
  if (totalBytes > 512 * 1024) {
    return res.status(400).json({ error: 'batch exceeds 512 KB' });
  }

  const session = await CapstoneSession.findOne({
    _id: req.params.session_id,
    user_id: req.user.userId,
  })
    .select('_id status sandbox_id')
    .lean();
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (!['ready', 'in_progress', 'paused'].includes(session.status)) {
    return res.status(409).json({ error: 'session_not_active', current_status: session.status });
  }
  if (!session.sandbox_id) {
    return res.status(409).json({ error: 'sandbox_not_provisioned' });
  }

  // Path safety: reject .. and empty segments before the adapter sees them.
  const safe = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
    const stripped = f.path.replace(/^\/+/, '');
    if (stripped.split('/').some((s) => s === '..' || s === '')) continue;
    safe.push({ path: `/home/user/${stripped}`, content: f.content });
  }

  try {
    const adapter = sandboxOrchestrator._adapter;
    await adapter.uploadFiles(session.sandbox_id, safe);
    for (const f of safe) {
      recordingService.emit(session._id, {
        type: 'file_write',
        payload: {
          path: f.path.replace(/^\/home\/user\//, ''),
          bytes: f.content.length,
          by: 'learner',
        },
      });
    }
    res.json({ persisted: safe.length });
  } catch (err) {
    res.status(500).json({ error: 'sandbox_error', message: err.message });
  }
}

/** GET /api/coding/capstones/:session_id/result */
async function getResult(req, res) {
  const session = await CapstoneSession.findOne({
    _id: req.params.session_id,
    user_id: req.user.userId,
  }).lean();
  if (!session) return res.status(404).json({ error: 'session_not_found' });

  if (session.status === 'graded' && session.result) {
    return res.json({ ...session.result, session_id: String(session._id) });
  }
  // Pending — surface 202 with status (matches drill-result polling pattern)
  return res.status(202).json({
    session_id: String(session._id),
    status: session.status,
    evaluating_started_at: session.evaluating_started_at,
  });
}

/**
 * Project an ArtifactBundle into the learner-visible shape (CapstoneBundleView).
 * Strips reference_solution, hidden_tests, seeded_mistakes (the things the
 * learner must not see).
 */
function projectBundle(bundle) {
  return {
    bundle_id: String(bundle._id),
    brief: bundle.brief,
    time_budget_minutes: bundle.time_budget_minutes,
    difficulty: bundle.difficulty,
    role_track: bundle.role_track,
    language: bundle.language,
    stack_variant: bundle.stack_variant,
    acceptance_criteria: bundle.acceptance_criteria || [],
    starter_repo: bundle.starter_repo || { files: [] },
    visible_tests: (bundle.visible_tests || []).map((t) => ({
      name: t.name,
      command: t.command,
    })),
    interview_parallel: bundle.interview_parallel,
  };
}

module.exports = {
  listLibrary,
  start,
  redeemPairing,
  getStatus,
  control,
  applyControl, // exported for sessionRoom WS handler
  appendEvents,
  runInSandbox,
  persistFiles,
  getResult,
};
