const mindMapService = require('../services/mindMapGenerationService');
const apiResponse = require('../utils/apiResponse');

const generateMindMap = async (req, res, next) => {
  try {
    const { contentId } = req.body;
    if (!contentId) return res.status(400).json(apiResponse.error('contentId is required'));
    const result = await mindMapService.generate(req.user.userId, contentId);
    res.json(apiResponse.success(result, 'Mind map generated'));
  } catch (err) { next(err); }
};

const listMindMaps = async (req, res, next) => {
  try {
    const data = await mindMapService.getUserMindMaps(req.user.userId, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const getMindMap = async (req, res, next) => {
  try {
    const data = await mindMapService.getMindMap(req.user.userId, req.params.id);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const deleteMindMap = async (req, res, next) => {
  try {
    const data = await mindMapService.deleteMindMap(req.user.userId, req.params.id);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

module.exports = { generateMindMap, listMindMaps, getMindMap, deleteMindMap };
