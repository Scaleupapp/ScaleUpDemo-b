'use strict';

/**
 * Admin assessment-recovery service (Wave 2 block 6).
 *
 *   findStuck()          — inventory of grading-stranded engine sessions
 *   regradeSession(id)   — reset + re-enqueue grading for ONE institution
 *                          AssessmentSession (by its engine type)
 *
 * Exposed via the existing admin router (auth + rbac('admin')):
 *   GET  /api/v1/admin/assessments/stuck
 *   POST /api/v1/admin/assessments/sessions/:id/regrade
 *
 * Everything is dependency-injected for tests.
 */

const DEFAULT_STUCK_MINUTES = 15;

function d(deps, key, loader) {
  return (deps && deps[key]) || loader();
}

/**
 * Inventory of stuck grading work across engines.
 *
 * - capstone: sessions sitting in submitted/evaluating past the threshold
 * - drill: attempts submitted past the threshold, plus terminal 'failed'
 * - interview: sessions completed/evaluating past the threshold with no evaluation
 *
 * @param {{ thresholdMinutes?: number }} [opts]
 * @param {object} [deps]
 * @returns {Promise<{ thresholdMinutes, capstone: [], drill: [], interview: [] }>}
 */
async function findStuck(opts = {}, deps = {}) {
  const thresholdMinutes = Number(opts.thresholdMinutes) > 0 ? Number(opts.thresholdMinutes) : DEFAULT_STUCK_MINUTES;
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  const CapstoneSession = d(deps, 'CapstoneSession', () => require('../../coding/models/capstoneSession.model'));
  const DrillAttempt = d(deps, 'DrillAttempt', () => require('../../coding/models/drillAttempt.model'));
  const InterviewSession = d(deps, 'InterviewSession', () => require('../../models/InterviewSession'));

  const [capstone, drillStuck, drillFailed, interview] = await Promise.all([
    CapstoneSession.find({ status: { $in: ['submitted', 'evaluating'] }, updatedAt: { $lt: cutoff } })
      .select('_id user_id status submitted_at updatedAt')
      .sort({ updatedAt: 1 })
      .limit(200)
      .lean(),
    DrillAttempt.find({ status: 'submitted', updatedAt: { $lt: cutoff } })
      .select('_id user_id drill_subtype status submitted_at updatedAt')
      .sort({ updatedAt: 1 })
      .limit(200)
      .lean(),
    DrillAttempt.find({ status: 'failed' })
      .select('_id user_id drill_subtype status failure_reason updatedAt')
      .sort({ updatedAt: 1 })
      .limit(200)
      .lean(),
    InterviewSession.find({
      status: { $in: ['completed', 'evaluating'] },
      updatedAt: { $lt: cutoff },
      'evaluation.overallScore': { $exists: false },
    })
      .select('_id userId status completedAt updatedAt')
      .sort({ updatedAt: 1 })
      .limit(200)
      .lean(),
  ]);

  return {
    thresholdMinutes,
    capstone,
    drill: [...drillFailed, ...drillStuck],
    interview,
  };
}

/**
 * Reset + re-enqueue grading for ONE institution AssessmentSession.
 *
 * @param {string} sessionId — AssessmentSession _id
 * @param {object} [deps]
 * @returns {Promise<{ engine: string, action: string }>}
 * @throws Error('NOT_FOUND' | 'UNSUPPORTED_ENGINE' | 'ALREADY_GRADED')
 */
async function regradeSession(sessionId, deps = {}) {
  const AssessmentSession = d(deps, 'AssessmentSession', () => require('../../models/AssessmentSession'));
  const session = await AssessmentSession.findById(sessionId);
  if (!session || !session.engine) throw new Error('NOT_FOUND');

  const engineType = session.engine.type;
  const engineSessionId = session.engine.sessionId;

  if (engineType === 'capstone') {
    const CapstoneSession = d(deps, 'CapstoneSession', () => require('../../coding/models/capstoneSession.model'));
    const capstoneEval = d(deps, 'capstoneEval', () => require('../../coding/workers/capstoneEval.worker'));
    const cs = await CapstoneSession.findById(engineSessionId);
    if (!cs) throw new Error('NOT_FOUND');
    // A wedged 'evaluating' is reverted so the pipeline restarts from a known state.
    if (cs.status === 'evaluating') {
      await CapstoneSession.findOneAndUpdate(
        { _id: engineSessionId, status: 'evaluating' },
        { $set: { status: 'submitted' } }
      );
    } else if (!['submitted', 'graded'].includes(cs.status)) {
      throw new Error('UNSUPPORTED_ENGINE_STATE');
    }
    // enqueueEvaluation clears an exhausted job on the idempotent jobId itself.
    await capstoneEval.enqueueEvaluation(String(engineSessionId));
    return { engine: 'capstone', action: 'requeued' };
  }

  if (engineType === 'drill') {
    const DrillAttempt = d(deps, 'DrillAttempt', () => require('../../coding/models/drillAttempt.model'));
    const workers = d(deps, 'codingWorkers', () => require('../../coding/workers'));
    const attempt = await DrillAttempt.findById(engineSessionId);
    if (!attempt) throw new Error('NOT_FOUND');
    if (!['failed', 'submitted', 'graded'].includes(attempt.status)) throw new Error('UNSUPPORTED_ENGINE_STATE');
    if (attempt.status === 'failed') {
      await DrillAttempt.findOneAndUpdate(
        { _id: engineSessionId, status: 'failed' },
        { $set: { status: 'submitted' }, $unset: { failure_reason: '' } }
      );
    }
    // Idempotent jobId: a double-clicked regrade must not enqueue two grading
    // jobs (double LLM spend + racing result writes) — review finding I3.
    // Clear any finished job occupying the id first (same pattern as capstone).
    const drillJobId = `regrade:drill:${engineSessionId}`;
    try {
      const existing = await workers.drillGraderQueue.getJob(drillJobId);
      if (existing) {
        const state = await existing.getState();
        if (['completed', 'failed'].includes(state)) await existing.remove();
      }
    } catch (_) { /* best-effort — add() below still carries the jobId guard */ }
    await workers.drillGraderQueue.add('grade', {
      drillAttemptId: String(engineSessionId),
      drill_subtype: attempt.drill_subtype,
    }, { jobId: drillJobId });
    return { engine: 'drill', action: 'requeued' };
  }

  if (engineType === 'interview') {
    const InterviewSession = d(deps, 'InterviewSession', () => require('../../models/InterviewSession'));
    const { interviewEvaluationQueue } = d(deps, 'queues', () => require('../../config/queue'));
    const iv = await InterviewSession.findById(engineSessionId);
    if (!iv) throw new Error('NOT_FOUND');
    // A wedged 'evaluating' reverts to 'completed' (the evaluator's entry state).
    if (iv.status === 'evaluating') {
      iv.status = 'completed';
      await iv.save();
    } else if (!['completed', 'evaluated'].includes(iv.status)) {
      throw new Error('UNSUPPORTED_ENGINE_STATE');
    }
    const ivJobId = `regrade:interview:${engineSessionId}`;
    try {
      const existing = await interviewEvaluationQueue.getJob(ivJobId);
      if (existing) {
        const state = await existing.getState();
        if (['completed', 'failed'].includes(state)) await existing.remove();
      }
    } catch (_) { /* best-effort */ }
    await interviewEvaluationQueue.add('evaluate', { sessionId: String(engineSessionId) }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      jobId: ivJobId,
    });
    return { engine: 'interview', action: 'requeued' };
  }

  // MCQ grades synchronously at submit — nothing to requeue.
  throw new Error('UNSUPPORTED_ENGINE');
}

module.exports = { findStuck, regradeSession, DEFAULT_STUCK_MINUTES };
