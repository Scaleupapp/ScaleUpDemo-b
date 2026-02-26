const knowledgeService = require('../services/knowledgeService');

async function analyzeQuiz(job) {
  const { attemptId, userId } = job.data;
  await knowledgeService.updateFromQuizAttempt(attemptId, userId);
}

module.exports = analyzeQuiz;
