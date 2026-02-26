const objectiveService = require('../services/objectiveService');
const apiResponse = require('../utils/apiResponse');

const getObjectives = async (req, res, next) => {
  try { res.json(apiResponse.success(await objectiveService.getObjectives(req.user.userId))); } catch (err) { next(err); }
};
const createObjective = async (req, res, next) => {
  try { res.status(201).json(apiResponse.success(await objectiveService.createObjective(req.user.userId, req.body))); } catch (err) { next(err); }
};
const updateObjective = async (req, res, next) => {
  try { res.json(apiResponse.success(await objectiveService.updateObjective(req.user.userId, req.params.id, req.body))); } catch (err) { next(err); }
};
const pauseObjective = async (req, res, next) => {
  try { res.json(apiResponse.success(await objectiveService.pauseObjective(req.user.userId, req.params.id))); } catch (err) { next(err); }
};
const resumeObjective = async (req, res, next) => {
  try { res.json(apiResponse.success(await objectiveService.resumeObjective(req.user.userId, req.params.id))); } catch (err) { next(err); }
};
const setPrimary = async (req, res, next) => {
  try { res.json(apiResponse.success(await objectiveService.setPrimary(req.user.userId, req.params.id))); } catch (err) { next(err); }
};

module.exports = { getObjectives, createObjective, updateObjective, pauseObjective, resumeObjective, setPrimary };
