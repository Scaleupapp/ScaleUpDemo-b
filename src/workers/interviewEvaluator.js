const interviewService = require('../services/interviewService');
const interviewProgramService = require('../services/interviewProgramService');

/**
 * Interview Evaluation Worker
 * Receives { sessionId } and evaluates the completed interview using Claude.
 */
async function evaluateInterview(job) {
  const { sessionId } = job.data;

  try {
    await job.updateProgress(10);
    console.log(`[InterviewEvaluator] Starting evaluation for session ${sessionId}`);
    const result = await interviewService.evaluateInterview(sessionId);
    await job.updateProgress(100);
    console.log(`[InterviewEvaluator] Completed evaluation for session ${sessionId}, score: ${result.evaluation?.overallScore}`);

    // Fire-and-forget: advance the learner's active interview-coach program
    // (agentic layer Plan 5, #4). Flag-gated + no-op-safe inside the service;
    // never awaited here so a slow/failing hook can't delay or fail the job.
    const userId = result.userId;
    interviewProgramService
      .attachSession({ userId, sessionId })
      .then((r) => (r.attached ? interviewProgramService.computeNextFocus({ userId }) : null))
      .catch((e) => console.warn('[interviewProgramHook]', e.message));

    return { status: 'completed', sessionId, overallScore: result.evaluation?.overallScore };
  } catch (err) {
    console.error(`[InterviewEvaluator] Failed for session=${sessionId}:`, err.message);
    throw err;
  }
}

module.exports = evaluateInterview;
