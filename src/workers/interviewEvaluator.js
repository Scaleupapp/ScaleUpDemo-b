const interviewService = require('../services/interviewService');

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
    return { status: 'completed', sessionId, overallScore: result.evaluation?.overallScore };
  } catch (err) {
    console.error(`[InterviewEvaluator] Failed for session=${sessionId}:`, err.message);
    throw err;
  }
}

module.exports = evaluateInterview;
