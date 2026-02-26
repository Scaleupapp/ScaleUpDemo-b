const quizGenerationService = require('../services/quizGenerationService');
const QuizTrigger = require('../models/QuizTrigger');

async function generateQuiz(job) {
  const { triggerId, topic } = job.data;
  console.log(`[QuizWorker] Starting quiz generation job ${job.id} for topic="${topic}"`);

  try {
    const quiz = await quizGenerationService.generateQuiz(job.data);
    console.log(`[QuizWorker] Job ${job.id} completed — quiz ${quiz._id} created`);
  } catch (err) {
    console.error(`[QuizWorker] Job ${job.id} failed for topic="${topic}":`, err.message);

    // Ensure trigger is marked as failed (service may have already done this)
    if (triggerId) {
      try {
        await QuizTrigger.findByIdAndUpdate(triggerId, { status: 'failed' });
      } catch (updateErr) {
        console.error(`[QuizWorker] Failed to update trigger status:`, updateErr.message);
      }
    }

    throw err; // Re-throw so BullMQ can retry or mark as permanently failed
  }
}

module.exports = generateQuiz;
