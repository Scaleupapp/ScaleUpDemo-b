const flashcardService = require('../services/flashcardGenerationService');

/**
 * Flashcard Generation Worker
 * Receives { userId, contentId } and generates a flashcard set using AI.
 */
async function generateFlashcards(job) {
  const { userId, contentId } = job.data;

  try {
    await job.updateProgress(10);
    const result = await flashcardService.generate(userId, contentId);
    await job.updateProgress(100);
    return { status: 'completed', flashcardSetId: result._id.toString(), totalCards: result.totalCards };
  } catch (err) {
    console.error(`[FlashcardGen] Failed for user=${userId} content=${contentId}:`, err.message);
    throw err;
  }
}

module.exports = generateFlashcards;
