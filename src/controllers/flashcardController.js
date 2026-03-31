const flashcardService = require('../services/flashcardGenerationService');
const { flashcardGenerationQueue } = require('../config/queue');
const apiResponse = require('../utils/apiResponse');

const generateFlashcards = async (req, res, next) => {
  try {
    const { contentId } = req.body;
    if (!contentId) return res.status(400).json(apiResponse.error('contentId is required'));

    // Queue async generation
    await flashcardGenerationQueue.add('generate', {
      userId: req.user.userId,
      contentId,
    }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    });

    res.status(202).json(apiResponse.success({ status: 'generating', contentId }, 'Flashcards are being generated'));
  } catch (err) { next(err); }
};

const listFlashcards = async (req, res, next) => {
  try {
    const data = await flashcardService.getUserFlashcards(req.user.userId, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const getFlashcardSet = async (req, res, next) => {
  try {
    const data = await flashcardService.getFlashcardSet(req.user.userId, req.params.id);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const recordStudy = async (req, res, next) => {
  try {
    const data = await flashcardService.recordStudySession(req.user.userId, req.params.id, req.body);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const deleteFlashcardSet = async (req, res, next) => {
  try {
    const data = await flashcardService.deleteFlashcardSet(req.user.userId, req.params.id);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

module.exports = { generateFlashcards, listFlashcards, getFlashcardSet, recordStudy, deleteFlashcardSet };
