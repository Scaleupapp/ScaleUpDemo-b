'use strict';
const { getAdapter } = require('./engineAdapters');

// ── Server-side duration enforcement (Wave 3 block 1) ────────────────────────

// durationSeconds lives on the engine-specific config sub-object (mcq/capstone/
// interview). Drill has none. Returns a positive number or 0 (no cap).
function getConfiguredDurationSeconds(assessment) {
  if (!assessment || !assessment.type) return 0;
  const cfg = (assessment.config && assessment.config[assessment.type]) || {};
  const d = cfg.durationSeconds;
  return typeof d === 'number' && d > 0 ? d : 0;
}

// deadlineAt = startedAt + durationSeconds, never beyond closesAt (min of the
// two). Returns null when there is no positive duration (closesAt still governs
// via the sync worker). Exported so routes/tests can reason about the contract.
function computeDeadlineAt(startedAt, durationSeconds, closesAt) {
  if (!durationSeconds || durationSeconds <= 0) return null;
  let deadline = new Date(new Date(startedAt).getTime() + durationSeconds * 1000);
  if (closesAt) {
    const c = new Date(closesAt);
    if (!isNaN(c.getTime()) && c < deadline) deadline = c;
  }
  return deadline;
}

// Start a student's single attempt: validate the assessment is released + in-window,
// enforce single attempt, spin up the engine session, persist the AssessmentSession.
async function startSession(userId, assessmentId, deps = {}) {
  const Assessment = deps.Assessment || require('../../../models/Assessment');
  const AssessmentSession = deps.AssessmentSession || require('../../../models/AssessmentSession');
  const Enrollment = deps.InstitutionEnrollment || require('../../../models/InstitutionEnrollment');

  const a = await Assessment.findById(assessmentId);
  if (!a) throw new Error('NOT_FOUND');
  if (a.status !== 'released') throw new Error('NOT_RELEASED');
  const now = (deps.now && deps.now()) || new Date();
  if (a.opensAt && now < a.opensAt) throw new Error('NOT_OPEN');
  if (a.closesAt && now > a.closesAt) throw new Error('CLOSED');

  // The student must be enrolled in the assessment's cohort.
  const enrollment = await Enrollment.findOne({ userId, cohortId: a.cohortId });
  if (!enrollment) throw new Error('NOT_ENROLLED');

  // Server-side duration cap: persist a per-session deadline so the engine sync
  // boundary + worker can auto-finalize a run that overruns (never beyond the
  // assessment's own closesAt window).
  const deadlineAt = computeDeadlineAt(now, getConfiguredDurationSeconds(a), a.closesAt);

  // Reserve-first: atomically claim the row before creating any engine session.
  // Concurrent starts: only one wins the unique-index write; the loser gets
  // a duplicate-key error (code 11000) and returns the winner's row without
  // ever spinning up an engine session.
  let session;
  try {
    session = await AssessmentSession.create({
      assessmentId,
      institutionId: a.institutionId,
      cohortId: a.cohortId,
      userId,
      enrollmentId: enrollment._id,
      engine: { type: a.type },
      status: 'scheduled',
      startedAt: now,
      ...(deadlineAt ? { deadlineAt } : {}),
    });
  } catch (e) {
    if (e.code === 11000) {
      // Another request already created the row — idempotent, no engine session
      // created for this loser request.
      return AssessmentSession.findOne({ assessmentId, userId });
    }
    throw e;
  }

  // Winner: start the engine session. If that fails, remove the placeholder
  // row so the student can retry cleanly.
  const adapter = getAdapter(a.type);
  let engineData;
  try {
    const out = await adapter.start(a, userId, deps.adapterDeps || {});
    engineData = out.engine;
  } catch (adapterErr) {
    await AssessmentSession.deleteOne({ _id: session._id });
    throw adapterErr;
  }

  session.engine = engineData;
  session.status = 'in_progress';
  await session.save();
  return session;
}

// Poll the engine; when graded, copy the summary, mark graded, advance enrollment to
// 'active', and recompute the rollup. Idempotent (no-op once graded).
async function syncSession(sessionId, deps = {}) {
  const AssessmentSession = deps.AssessmentSession || require('../../../models/AssessmentSession');
  const session = await AssessmentSession.findById(sessionId);
  if (!session) throw new Error('NOT_FOUND');
  // Terminal states are idempotent no-ops.
  if (session.status === 'graded' || session.status === 'expired') return session;

  const now = (deps.now && deps.now()) || new Date();
  const adapter = getAdapter(session.engine.type);
  const r = await adapter.readResult(session, deps.adapterDeps || {});
  if (!r.done) {
    // Past the per-session duration deadline with no engine result → auto-expire
    // (grade what exists if the engine has a result — handled below — else expire).
    // The worker's tick reaches this same path, so per-session deadlines expire
    // even when the assessment itself has no closesAt window.
    if (session.deadlineAt && now > new Date(session.deadlineAt)) {
      session.status = 'expired';
      await session.save();
    }
    return session; // still pending (or just expired)
  }

  session.status = 'graded';
  session.gradedAt = now;
  // Honest lifecycle (Wave 3 block 2): stamp the submission moment. Our engines
  // surface a result only once graded, so submittedAt == gradedAt here; a truly
  // async engine that reports submitted-before-graded would set it earlier.
  if (!session.submittedAt) session.submittedAt = now;
  session.result = {
    score: r.score,
    integrity: r.integrity,
    // Answer-side judge flag + insufficient-evidence marker (Wave 2). Both
    // optional — engines that don't emit them leave the fields unset.
    ...(r.needsReview !== undefined ? { needsReview: !!r.needsReview } : {}),
    ...(r.status && r.status !== 'graded' ? { gradeStatus: r.status } : {}),
    raw: r.raw,
  };
  await session.save();

  // Advance enrollment → active (best-effort; engines already fed readiness/mastery).
  try {
    const enrollmentProgress = deps.enrollmentProgressService || require('../enrollmentProgressService');
    await enrollmentProgress.markActive(session.userId, session.cohortId, deps);
  } catch (e) { console.warn('[assessmentSession] markActive failed', e.message); }

  // Recompute the cohort rollup (best-effort).
  try {
    const rollup = deps.cohortRollupService || require('./cohortRollupService');
    await rollup.recompute(session.institutionId, session.cohortId, session.assessmentId, deps);
  } catch (e) { console.warn('[assessmentSession] rollup recompute failed', e.message); }

  return session;
}

module.exports = { startSession, syncSession, getConfiguredDurationSeconds, computeDeadlineAt };
