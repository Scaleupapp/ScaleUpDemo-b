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
const capstoneSummary = require('../services/capstoneSummary');
const planIntegration = require('../services/planIntegration');
const CapstoneGenerationRequest = require('../models/capstoneGenerationRequest.model');
const capstoneGenerationWorker = require('../workers/capstoneGeneration.worker');
const DifficultyState = require('../models/difficultyState.model');
const { evaluateCodingEligibility } = require('../services/codingEligibility');
const capstoneSessionService = require('../services/capstoneSessionService');
const { abortNeverStartedSessions: abortNeverStartedSessionsSvc } = require('../services/capstoneSessionService');

// Default language per role-track for generated capstones (learner can't pick
// an arbitrary language; we map their track to its canonical language).
const LANG_BY_TRACK = { swe: 'javascript', ds: 'python', ai_eng: 'python' };

/**
 * Pick the capstone language from what the learner actually typed, falling back
 * to their track's default. Forcing the track language onto, say, a "SQL window
 * functions" request produced an incoherent JavaScript-about-SQL brief that the
 * model couldn't satisfy. Only override on a STRONG, unambiguous signal.
 * SQL/query topics map to python (runnable in-sandbox via the sqlite3 stdlib —
 * the learner writes real SQL, we execute it with python).
 */
function inferLanguageFromInput(text, fallback) {
  const t = ` ${String(text || '').toLowerCase()} `;
  if (/typescript|next\.?js|nest\.?js/.test(t)) return 'typescript';
  if (/\bgolang\b|\bgo lang\b|\bgoroutine/.test(t)) return 'go';
  if (/\brust\b|\bcargo\b|\btokio\b/.test(t)) return 'rust';
  if (/\bkotlin\b/.test(t)) return 'kotlin';
  if (/\bswift(ui)?\b/.test(t)) return 'swift';
  if (/\bc\+\+|\bcpp\b/.test(t)) return 'cpp';
  if (/\bjava\b(?!script)/.test(t)) return 'java';
  if (/\bsql\b|window function|\bpostgres\b|\bgroup by\b|\bjoins?\b|\bquery optim/.test(t)) return 'python';
  if (/\bpython\b|pandas|numpy|django|flask|fastapi|scikit|pytorch|tensorflow/.test(t)) return 'python';
  if (/\bjavascript\b|\bnode(\.?js)?\b|express|react/.test(t)) return 'javascript';
  return fallback;
}

async function resolveRoleTrackForUser(userId) {
  let UserObjective;
  try { UserObjective = require('../../models/UserObjective'); } catch { UserObjective = require('../../models/userObjective'); }
  const obj = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
  const eligibility = evaluateCodingEligibility(obj);
  return eligibility.eligible ? eligibility.role_track : null;
}

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
  const { difficulty, role_track, q } = req.query;
  const filter = { type: 'capstone', status: 'active' };
  if (difficulty) filter.difficulty = difficulty;
  if (role_track) filter.role_track = role_track;
  // Free-text browse across the whole catalog (title/brief, language, and the
  // interview-parallel blurb). Escape regex metacharacters so user input can't
  // throw or inject a pathological pattern.
  if (typeof q === 'string' && q.trim()) {
    const safe = q.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    filter.$or = [{ brief: rx }, { language: rx }, { interview_parallel: rx }];
  }

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
/**
 * Abort the user's NEVER-STARTED sessions (provisioned but never begun on the
 * laptop). These otherwise linger as a phantom "in progress" card and 409 the
 * next start/retry. Only never-started sessions (no started_at, pre-pairing
 * statuses) are touched — a genuinely in-progress/paused session is left alone.
 */
async function start(req, res) {
  const { bundle_id } = req.body || {};
  if (!bundle_id) return res.status(400).json({ error: 'bundle_id required' });

  let session;
  try {
    const result = await capstoneSessionService.startSession({ userId: req.user.userId, bundleId: bundle_id });
    session = result.session;
  } catch (err) {
    if (err.message === 'BUNDLE_NOT_FOUND') return res.status(404).json({ error: 'bundle_not_found' });
    if (err.message === 'NOT_A_CAPSTONE') return res.status(404).json({ error: 'not_a_capstone' });
    throw err;
  }

  const { code, expiresAt } = await pairingService.mintCode({
    userId: req.user.userId,
    sessionId: session._id,
  });

  // Async provision is now handled inside the service (non-blocking)

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

  // Opportunistic sandbox keepalive — e2b caps initial timeout at 1 hr;
  // every status poll re-extends to 55 min. Mobile polls every ~5 sec.
  void sandboxOrchestrator.heartbeatExtend(session._id);

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

  // Transition first, then RESPOND immediately. The heavy finalization for a
  // submit (snapshot the filetree for grading, finalize the recording, tear
  // down the sandbox, enqueue the evaluator) used to be awaited inline — on a
  // slow e2b/S3 call that blew the proxy timeout and the learner saw
  // "Couldn't submit: coding 502: http error". It now runs in the BACKGROUND.
  //
  // Order is preserved: the snapshot runs while status='submitted' (the gate
  // allows it) and the sandbox is still alive (teardown is later in the chain),
  // and the evaluator is enqueued only after the snapshot. The sandbox-gc
  // worker re-enqueues any 'submitted' session whose eval didn't get queued, so
  // a background hiccup can never lose a submission.
  const updated = await stateMachine.transition(sessionId, target);
  sessionRoom.publishLifecycle(sessionId, updated.status);

  if (target === 'submitted') {
    void (async () => {
      try {
        const snap = await snapshotService.captureForSession(sessionId);
        if (!snap?.captured) {
          // eslint-disable-next-line no-console
          console.warn(`[capstones.control] submit snapshot did NOT capture for ${sessionId}; evaluator may see empty filetree`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[capstones.control] submit snapshot failed:', err.message);
      }
      await recordingService.finalize(sessionId).catch(() => {});
      await sandboxOrchestrator.teardownForSession(sessionId).catch(() => {});
      await capstoneEvalWorker.enqueueEvaluation(sessionId).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[capstones.control] enqueue eval failed (gc will recover):', err.message);
      });
    })();
  } else if (target === 'aborted') {
    void (async () => {
      await recordingService.finalize(sessionId).catch(() => {});
      await sandboxOrchestrator.teardownForSession(sessionId).catch(() => {});
    })();
  }

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

  // Lazy-init the recording doc on the FIRST event for this session. Without
  // this, recordingService.flush silently returns without incrementing
  // counters because the CapstoneRecording row never exists — which is
  // why "Files changed: 0" and "Compass turns: 0" showed up even after the
  // learner edited code and ran a Compass turn.
  await recordingService.startRecording(session._id).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[capstones.events] startRecording lazy-init failed:', err.message);
  });

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
    // Crash-recovery: opportunistically snapshot the live filetree to S3 on
    // file flush. snapshotService dedups internally (≤ 1 / SNAPSHOT_INTERVAL_SEC),
    // so calling it on every flush is cheap — it no-ops if a snapshot was taken
    // in the last 60s. This ties snapshot freshness to actual editing activity
    // (exactly when there's work worth recovering) so a browser reload / sandbox
    // crash loses at most ~60s of edits instead of everything.
    void snapshotService.captureForSession(session._id).catch(() => {});
    res.json({ persisted: safe.length });
  } catch (err) {
    res.status(500).json({ error: 'sandbox_error', message: err.message });
  }
}

/**
 * GET /api/coding/capstones/:session_id/latest-snapshot
 *
 * Crash-recovery read path. Returns the most recent snapshot's filetree so the
 * web IDE can rehydrate the editor after a browser reload / sandbox reprovision.
 * Returns { has_snapshot: false } when none exists (fresh session) — the client
 * then falls back to the bundle's starter_repo.
 */
async function getLatestSnapshot(req, res) {
  const session = await CapstoneSession.findOne({
    _id: req.params.session_id,
    user_id: req.user.userId,
  })
    .select('_id status')
    .lean();
  if (!session) return res.status(404).json({ error: 'session_not_found' });

  const CapstoneRecording = require('../models/capstoneRecording.model');
  const recording = await CapstoneRecording.findOne({ session_id: session._id })
    .select('snapshots')
    .lean();
  const snaps = recording?.snapshots || [];
  if (snaps.length === 0) {
    return res.json({ has_snapshot: false });
  }
  const latest = snaps[snaps.length - 1];
  const loaded = await snapshotService.loadSnapshot(latest.s3_key).catch(() => null);
  if (!loaded || !Array.isArray(loaded.files)) {
    return res.json({ has_snapshot: false });
  }
  res.json({
    has_snapshot: true,
    t_seconds: latest.t_seconds,
    files: loaded.files.map((f) => ({ path: f.path, content: f.content })),
  });
}

/** GET /api/coding/capstones/:session_id/result */
async function getResult(req, res) {
  const session = await CapstoneSession.findOne({
    _id: req.params.session_id,
    user_id: req.user.userId,
  }).lean();
  if (!session) return res.status(404).json({ error: 'session_not_found' });

  if (session.status === 'graded' && session.result) {
    return res.json({
      ...session.result,
      session_id: String(session._id),
      bundle_id: String(session.bundle_id),
      is_retry: Boolean(session.is_retry),
    });
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

/**
 * GET /api/coding/capstones/summary
 *
 * Aggregated "how am I doing" snapshot for the mobile Compass tab. Returns
 * eligibility, current difficulty, mastery axes, last 5 graded capstones,
 * any in-progress session, next-available timestamp, and a one-line
 * summary suitable for direct display.
 */
async function getSummary(req, res) {
  const summary = await capstoneSummary.buildSummary(req.user.userId);
  res.json(summary);
}

/**
 * GET /api/coding/capstones/history?limit=30&offset=0
 *
 * Paginated list of every graded capstone for the learner + headline
 * trend stats. Powers the You-tab "All capstones" history and the
 * Compass-tab drill-down.
 */
async function getHistory(req, res) {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const userId = req.user.userId;
  const baseFilter = { user_id: userId, status: 'graded' };

  const [items, total, allScores] = await Promise.all([
    CapstoneSession.find(baseFilter)
      .sort({ graded_at: -1 })
      .skip(offset)
      .limit(limit)
      .populate('bundle_id', 'brief difficulty role_track time_budget_minutes language')
      .lean(),
    CapstoneSession.countDocuments(baseFilter),
    CapstoneSession.find(baseFilter).select('result.overall_score graded_at').lean(),
  ]);

  const scores = allScores
    .map((s) => s.result?.overall_score)
    .filter((n) => typeof n === 'number');
  const best = scores.length ? Math.max(...scores) : null;
  const mean = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  // Weekly score series for the last 8 weeks (oldest → newest).
  const WEEKS = 8;
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const weeklySeries = [];
  for (let i = WEEKS - 1; i >= 0; i -= 1) {
    const windowStart = now - (i + 1) * weekMs;
    const windowEnd = now - i * weekMs;
    const inWindow = allScores.filter((s) => {
      const t = s.graded_at ? new Date(s.graded_at).getTime() : 0;
      return t >= windowStart && t < windowEnd;
    });
    weeklySeries.push({
      week_index_from_end: i,
      count: inWindow.length,
      mean_score: inWindow.length
        ? Math.round(inWindow.reduce((a, b) => a + (b.result?.overall_score || 0), 0) / inWindow.length)
        : null,
    });
  }

  const DifficultyState = require('../models/difficultyState.model');
  let UserObjective;
  try { UserObjective = require('../../models/UserObjective'); } catch { UserObjective = require('../../models/userObjective'); }
  const userObjective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
  const roleTrack = userObjective ? require('../services/codingEligibility').evaluateCodingEligibility(userObjective).role_track : null;
  const diffState = roleTrack ? await DifficultyState.findOne({ user_id: userId, role_track: roleTrack }).lean() : null;

  res.json({
    items: items.map((s) => ({
      session_id: String(s._id),
      bundle_id: s.bundle_id?._id ? String(s.bundle_id._id) : null,
      bundle_brief_preview: shortenBriefForHistory(s.bundle_id?.brief),
      difficulty: s.bundle_id?.difficulty ?? null,
      role_track: s.bundle_id?.role_track ?? null,
      time_budget_minutes: s.bundle_id?.time_budget_minutes ?? null,
      overall_score: s.result?.overall_score ?? null,
      dimension_scores: s.result?.dimension_scores ?? null,
      integrity_confidence: s.result?.integrity_confidence ?? null,
      graded_at: s.graded_at,
      is_retry: !!s.is_retry,
    })),
    pagination: { total, limit, offset, returned: items.length },
    stats: {
      total_attempts: total,
      best_score: best,
      mean_score: mean,
      current_difficulty: diffState?.current_difficulty ?? null,
      role_track: roleTrack,
    },
    weekly_series: weeklySeries,
  });
}

function shortenBriefForHistory(brief) {
  if (!brief) return '';
  // Title only (first non-empty line).
  const firstLine = (String(brief).split('\n').find((l) => l.trim().length > 0) || '').trim();
  return firstLine.length > 100 ? firstLine.slice(0, 100).trimEnd() + '…' : firstLine;
}

/**
 * POST /api/coding/capstones/retry
 *
 * Start a fresh session against a bundle the learner has already graded.
 * The previous result stays in history; this creates a new session_id +
 * fresh pairing code. Refuses if:
 *   - No prior graded session against that bundle (use /start instead)
 *   - There's an in-progress session (must finish or abort first)
 */
async function retry(req, res) {
  const { bundle_id } = req.body || {};
  if (!bundle_id) return res.status(400).json({ error: 'bundle_id required' });

  const bundle = await ArtifactBundle.findById(bundle_id).lean();
  if (!bundle) return res.status(404).json({ error: 'bundle_not_found' });
  if (bundle.type !== 'capstone') return res.status(404).json({ error: 'not_a_capstone' });

  const priorGraded = await CapstoneSession.exists({
    user_id: req.user.userId,
    bundle_id: bundle._id,
    status: 'graded',
  });
  if (!priorGraded) {
    return res.status(400).json({ error: 'no_prior_attempt', message: 'Use /start for first attempts.' });
  }

  // Clear any never-started leftovers (a previous Start that provisioned but
  // was never begun on the laptop). Those used to linger as a phantom "in
  // progress" and 409 the retry. Only a genuinely-active session blocks now.
  await abortNeverStartedSessionsSvc(req.user.userId);
  const inProgress = await CapstoneSession.exists({
    user_id: req.user.userId,
    status: { $in: ['in_progress', 'paused', 'submitted', 'evaluating'] },
  });
  if (inProgress) {
    return res.status(409).json({ error: 'session_in_progress', message: 'Finish or abort the current session first.' });
  }

  const session = await CapstoneSession.create({
    user_id: req.user.userId,
    bundle_id: bundle._id,
    status: 'scheduled',
    time_budget_seconds: bundle.time_budget_minutes * 60,
    is_retry: true,
  });

  const { code, expiresAt } = await pairingService.mintCode({
    userId: req.user.userId,
    sessionId: session._id,
  });

  sandboxOrchestrator.provisionForSession(session._id).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[capstones.retry] provision failed:', err.message);
  });

  res.status(201).json({
    session_id: String(session._id),
    status: session.status,
    pairing_code: code,
    expires_at: expiresAt,
    time_budget_seconds: session.time_budget_seconds,
    is_retry: true,
  });
}

/**
 * POST /api/coding/capstones/request
 *
 * "Surprise me" — picks the best next capstone for the learner based on
 * role_track + recalibrated difficulty + weakest mastery axis. Same
 * eligibility + 7-day cadence rules as the auto-surfaced milestone.
 *
 * Returns the bundle (without solution/hidden tests) so the mobile UI can
 * preview before starting — does NOT auto-start a session. The caller
 * then POSTs /start with the returned bundle_id.
 */
async function requestNext(req, res) {
  const candidate = await planIntegration.getCapstoneMilestone(req.user.userId);
  if (!candidate) {
    return res.status(409).json({
      error: 'no_capstone_available',
      message: 'You either have one in progress, completed one in the last 7 days, or have no matching bundle yet.',
    });
  }
  const bundle = await ArtifactBundle.findById(candidate.bundle_id).lean();
  if (!bundle) return res.status(404).json({ error: 'bundle_disappeared' });
  res.json({
    bundle: projectBundle(bundle),
    cadence: 'weekly',
    reason: `Picked for ${candidate.role_track} at ${candidate.difficulty} difficulty.`,
  });
}

/**
 * POST /api/coding/capstones/generate
 *
 * Learner-initiated custom capstone generation from a job description / topic.
 * Open to any eligible learner (rate-limited). Returns immediately with a
 * request_id; the heavy generate→validate→cross-check→activate work runs in a
 * worker. Client polls GET /capstones/generations/:request_id.
 *
 * Body: { job_description?: string, topic_hint?: string, difficulty?: 'easy'|'medium'|'hard' }
 */
async function generateCapstone(req, res) {
  const { job_description = '', topic_hint = '', difficulty } = req.body || {};
  const jd = String(job_description).trim();
  const hint = String(topic_hint).trim();
  if (jd.length === 0 && hint.length === 0) {
    return res.status(400).json({ error: 'need_input', message: 'Provide a job description or a topic.' });
  }
  if (jd.length > 8000 || hint.length > 500) {
    return res.status(400).json({ error: 'input_too_long' });
  }

  const roleTrack = await resolveRoleTrackForUser(req.user.userId);
  if (!roleTrack) {
    return res.status(409).json({
      error: 'no_coding_track',
      message: 'Set a coding objective (SWE / Data Science / AI engineering) to generate capstones.',
    });
  }

  // Difficulty: honour an explicit valid choice, else use the learner's
  // recalibrated level, else default medium.
  let diff = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : null;
  if (!diff) {
    const ds = await DifficultyState.findOne({ user_id: req.user.userId, role_track: roleTrack }).lean();
    const cur = ds?.current_difficulty;
    diff = ['easy', 'medium', 'hard'].includes(cur) ? cur : 'medium';
  }

  const language = inferLanguageFromInput(`${jd} ${hint}`, LANG_BY_TRACK[roleTrack] || 'python');

  const reqDoc = await CapstoneGenerationRequest.create({
    user_id: req.user.userId,
    job_description: jd,
    topic_hint: hint,
    role_track: roleTrack,
    difficulty: diff,
    language,
    status: 'queued',
  });

  // Enqueue is awaited: if the queue (Redis) is down, the job would never
  // run and the learner would poll a 'queued' request forever. Mark the
  // request failed and tell the client now, rather than hang silently.
  try {
    await capstoneGenerationWorker.enqueueGeneration(reqDoc._id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[capstones.generate] enqueue failed:', err.message);
    await CapstoneGenerationRequest.findByIdAndUpdate(reqDoc._id, {
      $set: { status: 'failed', error: 'Could not queue generation. Try again shortly.' },
    }).catch(() => {});
    return res.status(503).json({
      error: 'generation_unavailable',
      message: 'Generation is temporarily unavailable. Please try again in a moment.',
    });
  }

  res.status(202).json({
    request_id: String(reqDoc._id),
    status: 'queued',
    role_track: roleTrack,
    difficulty: diff,
    language,
    estimated_seconds: 120,
  });
}

/**
 * GET /api/coding/capstones/generations/:request_id
 *
 * Poll a generation request. When status==='ready', includes the attemptable
 * bundle (preview-safe projection). When 'failed', includes a learner-readable
 * reason + allows a retry from the client.
 */
async function getGenerationStatus(req, res) {
  const reqDoc = await CapstoneGenerationRequest.findOne({
    _id: req.params.request_id,
    user_id: req.user.userId,
  }).lean();
  if (!reqDoc) return res.status(404).json({ error: 'request_not_found' });

  const out = {
    request_id: String(reqDoc._id),
    status: reqDoc.status,
    role_track: reqDoc.role_track,
    difficulty: reqDoc.difficulty,
    attempts: reqDoc.attempts || 0,
  };
  if (reqDoc.status === 'failed') {
    out.error = reqDoc.error || 'generation failed';
  }
  if (reqDoc.status === 'ready' && reqDoc.bundle_id) {
    const bundle = await ArtifactBundle.findById(reqDoc.bundle_id).lean();
    if (bundle) out.bundle = projectBundle(bundle);
  }
  res.json(out);
}

/**
 * GET /api/coding/capstones/generations
 *
 * The learner's recent on-demand generation requests, newest first. Lets the
 * Coding hub surface "Building…" / "Ready — Start" / "Failed — Retry" without
 * the client holding a long poll, so the learner can submit and walk away.
 */
async function listGenerations(req, res) {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
  const reqs = await CapstoneGenerationRequest.find({ user_id: req.user.userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const readyIds = reqs.filter((r) => r.status === 'ready' && r.bundle_id).map((r) => r.bundle_id);
  const bundles = readyIds.length
    ? await ArtifactBundle.find({ _id: { $in: readyIds } }).select('brief difficulty role_track').lean()
    : [];
  const byId = new Map(bundles.map((b) => [String(b._id), b]));

  res.json({
    generations: reqs.map((r) => {
      const b = r.bundle_id ? byId.get(String(r.bundle_id)) : null;
      return {
        request_id: String(r._id),
        status: r.status, // queued|generating|validating|cross_checking|ready|failed
        difficulty: r.difficulty,
        role_track: r.role_track,
        bundle_id: r.bundle_id ? String(r.bundle_id) : null,
        brief_preview: b ? shortenBriefForHistory(b.brief) : null,
        error: r.status === 'failed' ? (r.error || 'generation failed') : null,
        created_at: r.createdAt,
      };
    }),
  });
}

/**
 * GET /api/coding/capstones/track
 *
 * Returns the learner's auto-assembled track. If they're eligible and not yet
 * enrolled, auto-enrolls them (assembling a ramping sequence) on first call.
 * Returns { enrolled: false } when the learner has no coding track or there
 * aren't enough bundles to build one.
 */
async function getTrack(req, res) {
  const trackService = require('../services/capstoneTrackService');
  const roleTrack = await resolveRoleTrackForUser(req.user.userId);
  if (!roleTrack) return res.json({ enrolled: false, reason: 'no_coding_track' });

  let enrollment = await trackService.getActiveEnrollment(req.user.userId);
  if (!enrollment) {
    enrollment = await trackService.enrollAutoTrack(req.user.userId, roleTrack);
  }
  if (!enrollment) return res.json({ enrolled: false, reason: 'not_enough_bundles' });

  // Re-derive each step's preview from the bundle's current title (first line)
  // on READ. The stored brief_preview was frozen at enrollment time, so older
  // tracks have the whole brief mashed onto one line — that's the text that was
  // overflowing the rows. Title-only keeps them clean without a migration.
  const stepBundleIds = enrollment.steps.map((s) => s.bundle_id);
  const stepBundles = await ArtifactBundle.find({ _id: { $in: stepBundleIds } }).select('brief').lean();
  const briefById = new Map(stepBundles.map((b) => [String(b._id), b.brief]));

  res.json({
    enrolled: true,
    title: enrollment.title,
    role_track: enrollment.role_track,
    current_step: enrollment.current_step,
    total_steps: enrollment.steps.length,
    completed: !enrollment.is_active,
    steps: enrollment.steps.map((s, i) => ({
      index: i,
      bundle_id: String(s.bundle_id),
      difficulty: s.difficulty,
      brief_preview: shortenBriefForHistory(briefById.get(String(s.bundle_id))) || s.brief_preview,
      status: s.status,
      overall_score: s.overall_score,
      completed_at: s.completed_at,
    })),
  });
}

/**
 * POST /api/coding/capstones/:session_id/rejoin
 *
 * A learner who closed their laptop browser (letting the 10-min pairing code
 * expire) can call this to get a FRESH code for the SAME already-in-progress
 * session, without creating a new session or disturbing the running sandbox.
 *
 * Rules:
 *   - Auth: same candidate JWT as every other capstone endpoint.
 *   - Ownership: the session must belong to req.user.userId.
 *   - Resumable statuses: `in_progress` or `paused` only.
 *     graded / aborted / expired / submitted / evaluating → 409 NOT_RESUMABLE.
 *   - Does NOT pause, reset, or touch the session record in any way —
 *     just mints a new PairingCode bound to the existing session_id.
 *   - Response mirrors the start/retry pairing block so the apps can reuse
 *     their existing pairing UI without changes.
 */
async function rejoin(req, res) {
  const { session_id } = req.params;

  const session = await CapstoneSession.findOne({
    _id: session_id,
    user_id: req.user.userId,
  })
    .select('_id status')
    .lean();

  if (!session) {
    return res.status(404).json({ error: 'session_not_found' });
  }

  const RESUMABLE = new Set(['in_progress', 'paused']);
  if (!RESUMABLE.has(session.status)) {
    return res.status(409).json({
      error: 'NOT_RESUMABLE',
      current_status: session.status,
      message: 'Session is not in_progress or paused — cannot issue a new pairing code.',
    });
  }

  const { code, expiresAt } = await pairingService.mintCode({
    userId: req.user.userId,
    sessionId: session._id,
  });

  return res.json({
    session_id: String(session._id),
    pairing_code: code,
    expires_at: expiresAt,
  });
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
  getSummary,
  getHistory,
  getLatestSnapshot,
  retry,
  requestNext,
  generateCapstone,
  getGenerationStatus,
  listGenerations,
  getTrack,
  rejoin,
};
