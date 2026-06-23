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

  // Single attempt: return the existing session instead of starting another.
  const existing = await AssessmentSession.findOne({ assessmentId, userId });
  if (existing) return existing;

  const adapter = getAdapter(a.type);
  const { engine } = await adapter.start(a, userId, deps.adapterDeps || {});

  return AssessmentSession.create({
    assessmentId, institutionId: a.institutionId, cohortId: a.cohortId, userId,
    enrollmentId: enrollment._id, engine, status: 'in_progress', startedAt: now,
  });
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
  session.result = { score: r.score, integrity: r.integrity, raw: r.raw };
  await session.save();

  // Advance enrollment → active (best-effort; engines already fed readiness/mastery).
  try {
    const enrollmentProgress = deps.enrollmentProgressService || require('../enrollmentProgressService');
    await enrollmentProgress.markActive(session.userId, deps);
  } catch (e) { console.warn('[assessmentSession] markActive failed', e.message); }

  // Recompute the cohort rollup (best-effort).
  try {
    const rollup = deps.cohortRollupService || require('./cohortRollupService');
    await rollup.recompute(session.institutionId, session.cohortId, session.assessmentId, deps);
  } catch (e) { console.warn('[assessmentSession] rollup recompute failed', e.message); }

  return session;
}

module.exports = { startSession, syncSession };
