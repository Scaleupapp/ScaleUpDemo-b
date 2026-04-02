const audioSummaryService = require('../services/audioSummaryService');
const { audioSummaryQueue } = require('../config/queue');
const apiResponse = require('../utils/apiResponse');

const generateAudioSummary = async (req, res, next) => {
  try {
    const { contentId } = req.body;
    if (!contentId) return res.status(400).json(apiResponse.error('contentId is required'));

    // Queue async generation
    await audioSummaryQueue.add('generate', { contentId });
    res.json(apiResponse.success({ status: 'generating', contentId }, 'Audio summary generation started'));
  } catch (err) { next(err); }
};

const getAudioSummary = async (req, res, next) => {
  try {
    const data = await audioSummaryService.getAudioURL(req.params.contentId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const getAudioStatus = async (req, res, next) => {
  try {
    const data = await audioSummaryService.getStatus(req.params.contentId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

module.exports = { generateAudioSummary, getAudioSummary, getAudioStatus };
