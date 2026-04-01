const flashcardService = require('../services/flashcardGenerationService');
const { flashcardGenerationQueue } = require('../config/queue');
const apiResponse = require('../utils/apiResponse');

const generateFlashcards = async (req, res, next) => {
  try {
    const { contentId } = req.body;
    if (!contentId) return res.status(400).json(apiResponse.error('contentId is required'));

    // Generate synchronously — GPT-4o takes 3-5 seconds, acceptable for UX
    const result = await flashcardService.generate(req.user.userId, contentId);
    res.json(apiResponse.success(result, 'Flashcards generated'));
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
