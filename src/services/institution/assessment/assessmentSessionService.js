'use strict';
const { getAdapter } = require('./engineAdapters');

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
  if (session.status === 'graded') return session;

  const adapter = getAdapter(session.engine.type);
  const r = await adapter.readResult(session, deps.adapterDeps || {});
  if (!r.done) return session; // still pending

  session.status = 'graded';
  session.gradedAt = (deps.now && deps.now()) || new Date();
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

module.exports = { startSession, syncSession };
