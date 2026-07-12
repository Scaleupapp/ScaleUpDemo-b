'use strict';

/**
 * interviewProgramService — the interview coach agent (#4, flag
 * `interview_coach`).
 *
 * Turns one-off mock interviews into a coached multi-week PROGRAM: sessions
 * attach to the user's active program as they're graded (via a
 * post-evaluation hook, Task 2), and computeNextFocus does pure dimension-
 * trend math over the attached graded sessions to recommend which of the
 * four evaluation dimensions (communication/content/structure/confidence —
 * see InterviewSession.evaluation.<dimension>.score) to work on next.
 *
 * Every function is flag-gated on `interview_coach` and takes an optional
 * `deps` for test injection (repo convention: zero network/DB in tests).
 * Flag off -> no-op / null return, zero writes — mirrors misconceptionService
 * and activationAgentService.
 */

const DIMENSIONS = ['communication', 'content', 'structure', 'confidence'];

const DIMENSION_LABEL = {
  communication: 'Communication',
  content: 'Content',
  structure: 'Structure',
  confidence: 'Confidence',
};

// Honest, hand-written coaching copy per dimension — NOT LLM-generated. Kept
// short and concrete so it reads as real advice, not filler.
const DIMENSION_TIP = {
  communication: 'aim for clearer, more concise delivery — cut filler words and get to the point faster.',
  content: 'go deeper on specifics — cite metrics, outcomes, and concrete examples instead of general statements.',
  structure: 'organize your answers with a clear framework (e.g. STAR) before you start talking.',
  confidence: 'slow down, own your answers, and cut hedging language ("I think", "maybe", "sort of").',
};

function defaultDeps() {
  return {
    InterviewProgram: require('../models/InterviewProgram'),
    InterviewSession: require('../models/InterviewSession'),
    record: require('./agentDecisionService').record,
    isAgentEnabled: require('../config/agentFlags').isAgentEnabled,
    now: () => new Date(),
  };
}

/**
 * weeksElapsed for the client "week strip" — 1-indexed, clamped to
 * [1, totalWeeks] so a brand-new program shows "week 1" (not 0) and an
 * overrun program never shows past the last week slot.
 */
function computeWeeksElapsed(createdAt, now, totalWeeks) {
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const elapsed = Math.floor((now.getTime() - created.getTime()) / MS_PER_WEEK) + 1;
  const total = totalWeeks && totalWeeks > 0 ? totalWeeks : 1;
  return Math.max(1, Math.min(total, elapsed));
}

/**
 * Load this program's graded sessions (status 'evaluated' AND
 * evaluation.gradeStatus 'graded' — excludes 'insufficient' grades, which
 * carry no usable dimension scores), oldest first so "latest" and "previous"
 * below mean what they say regardless of sessionIds push order.
 */
async function loadGradedSessions(program, d) {
  const ids = program.sessionIds || [];
  if (!ids.length) return [];
  return d.InterviewSession.find({
    _id: { $in: ids },
    status: 'evaluated',
    'evaluation.gradeStatus': 'graded',
  }).sort({ completedAt: 1, createdAt: 1 }).lean();
}

/**
 * Per-dimension score series + latest/delta, from oldest-first graded
 * sessions. `delta` is latest - previous graded score for that dimension,
 * or null when fewer than 2 scores exist for it (baseline).
 */
function buildDimensionStats(gradedSessions) {
  return DIMENSIONS.map((dimension) => {
    const scores = gradedSessions
      .map((s) => s && s.evaluation && s.evaluation[dimension] && s.evaluation[dimension].score)
      .filter((v) => typeof v === 'number');
    const latest = scores.length ? scores[scores.length - 1] : null;
    const delta = scores.length >= 2 ? scores[scores.length - 1] - scores[scores.length - 2] : null;
    return { dimension, scores, latest, delta };
  });
}

/**
 * Pick the focus dimension: lowest latest score; on a tie, the dimension
 * declining most sharply (most negative delta) wins — it needs attention
 * NOW, not just historically. A null delta (baseline / not enough data for
 * that dimension) is treated as 0 (neutral) for the tie-break, so an actually
 * declining dimension always beats a merely-tied-but-flat one. If scores AND
 * deltas are both fully tied, the first dimension in DIMENSIONS wins
 * (communication > content > structure > confidence) — deterministic, not
 * meaningful ordering.
 */
function pickFocusDimension(dimStats) {
  const withScore = dimStats.filter((d) => d.latest != null);
  let best = null;
  for (const d of withScore) {
    if (!best) { best = d; continue; }
    if (d.latest < best.latest) { best = d; continue; }
    if (d.latest === best.latest) {
      const dDelta = d.delta == null ? 0 : d.delta;
      const bestDelta = best.delta == null ? 0 : best.delta;
      if (dDelta < bestDelta) best = d;
    }
  }
  return best;
}

function buildFocusReason(picked, sessionsCompleted) {
  const label = DIMENSION_LABEL[picked.dimension];
  if (sessionsCompleted <= 1 || picked.delta == null) {
    return `${label} is your lowest-scoring area (${picked.latest}/100) so far.`;
  }
  if (picked.delta < 0) {
    return `${label} is your lowest score (${picked.latest}/100) and dropped ${Math.abs(picked.delta)} pts since your last session.`;
  }
  if (picked.delta > 0) {
    return `${label} is still your lowest score (${picked.latest}/100), though it improved ${picked.delta} pts since your last session.`;
  }
  return `${label} is your lowest score (${picked.latest}/100) and unchanged since your last session.`;
}

/**
 * Pure computation: trends + focus from a list of graded sessions
 * (oldest-first). No DB writes, no ledger — used by both computeNextFocus
 * (which layers persistence on top) and getProgram (read-only presentation).
 *
 * No graded sessions -> focus is a null-dimension placeholder with reason
 * 'baseline needed', so callers can always render `focus.reason` without a
 * null check on `focus` itself.
 */
function computeTrendsAndFocus(gradedSessions) {
  const sessionsCompleted = gradedSessions.length;
  const dimStats = buildDimensionStats(gradedSessions);
  const trends = dimStats.map(({ dimension, scores, delta }) => ({ dimension, scores, delta }));

  if (sessionsCompleted === 0) {
    return {
      focus: { dimension: null, score: null, delta: null, reason: 'baseline needed' },
      trends,
      sessionsCompleted,
    };
  }

  const picked = pickFocusDimension(dimStats);
  const focus = {
    dimension: picked.dimension,
    score: picked.latest,
    delta: picked.delta,
    reason: buildFocusReason(picked, sessionsCompleted),
  };
  return { focus, trends, sessionsCompleted };
}

/**
 * createProgram({ userId, targetRole, targetCompany, driveDate, weeks }, deps)
 *   -> Promise<InterviewProgram|null>
 *
 * Guards one-active-per-user (see InterviewProgram.js doc comment for the
 * two-layer enforcement). Records a 'recommendation' ledger row on success.
 * Flag off -> null, zero writes.
 */
async function createProgram({ userId, targetRole, targetCompany, driveDate, weeks }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!d.isAgentEnabled('interview_coach')) return null;

  const existing = await d.InterviewProgram.findOne({ userId, status: 'active' });
  if (existing) {
    throw new Error('program already active');
  }

  const effectiveWeeks = weeks && weeks > 0 ? weeks : 4;
  let program;
  try {
    program = await d.InterviewProgram.create({
      userId,
      targetRole,
      targetCompany,
      driveDate,
      weeks: effectiveWeeks,
      status: 'active',
      sessionIds: [],
      focusHistory: [],
    });
  } catch (err) {
    // Race backstop: partial unique index one_active_program_per_user.
    if (err && err.code === 11000) {
      throw new Error('program already active');
    }
    throw err;
  }

  try {
    await d.record({
      agentId: 'interview_coach',
      decisionType: 'recommendation',
      userId,
      action: { kind: 'program_created', targetRole, targetCompany, driveDate, weeks: effectiveWeeks },
      promptVersion: 'interview-coach-v1',
    }, d);
  } catch (err) {
    console.warn('[interviewProgramService] program_created ledger record failed:', err.message);
  }

  return program;
}

/**
 * attachSession({ userId, sessionId }, deps) -> Promise<{ attached: boolean }>
 *
 * Hook target (Task 2): called fire-and-forget after an interview evaluation
 * persists. Never throws on "nothing to attach to" — no active program (or
 * flag off) is a safe, silent no-op so a missing program never breaks the
 * evaluation worker's critical path.
 */
async function attachSession({ userId, sessionId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!d.isAgentEnabled('interview_coach')) return { attached: false };

  const program = await d.InterviewProgram.findOne({ userId, status: 'active' });
  if (!program) return { attached: false };

  program.sessionIds.push(sessionId);
  await program.save();
  return { attached: true };
}

/**
 * computeNextFocus({ userId }, deps)
 *   -> Promise<{ focus, trends, sessionsCompleted, weeksElapsed } | null>
 *
 * Pure dimension-trend math (see computeTrendsAndFocus) over the active
 * program's graded sessions, PLUS the persistence side-effect: appends a
 * focusHistory row and records a ledger 'recommendation' row ONLY when the
 * focus dimension actually changed vs the last focusHistory entry (or there
 * is no prior entry yet) — repeated computeNextFocus calls that land on the
 * same dimension never spam the ledger.
 *
 * null when the flag is off or there's no active program.
 */
async function computeNextFocus({ userId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!d.isAgentEnabled('interview_coach')) return null;

  const program = await d.InterviewProgram.findOne({ userId, status: 'active' });
  if (!program) return null;

  const gradedSessions = await loadGradedSessions(program, d);
  const { focus, trends, sessionsCompleted } = computeTrendsAndFocus(gradedSessions);

  const now = (d.now && d.now()) || new Date();
  const weeksElapsed = computeWeeksElapsed(program.createdAt, now, program.weeks);

  const lastEntry = program.focusHistory.length
    ? program.focusHistory[program.focusHistory.length - 1]
    : null;
  const changed = !!focus.dimension && (!lastEntry || lastEntry.dimension !== focus.dimension);

  if (changed) {
    const lastSessionId = gradedSessions.length ? gradedSessions[gradedSessions.length - 1]._id : undefined;
    program.focusHistory.push({
      at: now,
      dimension: focus.dimension,
      reason: focus.reason,
      sessionId: lastSessionId,
    });
    await program.save();

    try {
      await d.record({
        agentId: 'interview_coach',
        decisionType: 'recommendation',
        userId,
        action: { kind: 'session_focus', dimension: focus.dimension, reason: focus.reason },
        promptVersion: 'interview-coach-v1',
      }, d);
    } catch (err) {
      console.warn('[interviewProgramService] session_focus ledger record failed:', err.message);
    }
  }

  return { focus, trends, sessionsCompleted, weeksElapsed };
}

/**
 * getProgram({ userId }, deps) -> Promise<object|null>
 *
 * Read-only client shape for the active program: target, week strip, trends,
 * focus, and honest hand-written next-session suggestion copy. Computes
 * trends/focus itself (read-only — no focusHistory/ledger writes) rather
 * than calling computeNextFocus, so a GET never has side effects.
 *
 * null when the flag is off or there's no active program.
 */
async function getProgram({ userId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!d.isAgentEnabled('interview_coach')) return null;

  const program = await d.InterviewProgram.findOne({ userId, status: 'active' }).lean();
  if (!program) return null;

  const gradedSessions = await loadGradedSessions(program, d);
  const { focus, trends, sessionsCompleted } = computeTrendsAndFocus(gradedSessions);

  const now = (d.now && d.now()) || new Date();
  const weeksElapsed = computeWeeksElapsed(program.createdAt, now, program.weeks);

  const suggestion = focus.dimension
    ? `Your next session should focus on ${DIMENSION_LABEL[focus.dimension]}: ${DIMENSION_TIP[focus.dimension]}`
    : 'Complete your first graded mock interview to unlock a personalized focus area.';

  return {
    _id: program._id,
    status: program.status,
    target: {
      role: program.targetRole || null,
      company: program.targetCompany || null,
      driveDate: program.driveDate || null,
    },
    weekStrip: { current: weeksElapsed, total: program.weeks },
    trends,
    focus,
    suggestion,
    sessionsCompleted,
    createdAt: program.createdAt,
  };
}

module.exports = {
  createProgram,
  attachSession,
  computeNextFocus,
  getProgram,
  _helpers: {
    DIMENSIONS,
    DIMENSION_LABEL,
    DIMENSION_TIP,
    computeWeeksElapsed,
    buildDimensionStats,
    pickFocusDimension,
    buildFocusReason,
    computeTrendsAndFocus,
    loadGradedSessions,
  },
};
