const objectiveService = require('../services/objectiveService');
const objectiveAnalysisService = require('../services/objectiveAnalysisService');
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
const deleteObjective = async (req, res, next) => {
  try { res.json(apiResponse.success(await objectiveService.deleteObjective(req.user.userId, req.params.id))); } catch (err) { next(err); }
};

// --- Objective Intelligence Engine ---

const analyzeObjective = async (req, res) => {
  // Fire-and-forget. The LLM competency analysis runs longer than nginx's 30s
  // proxy timeout, which returned a 502 to the client even though the work
  // completed server-side (the client then showed "Analysis failed"). Kick it
  // off in the background and return 202 immediately; the client already polls
  // getObjectiveBrief for the result (ObjectiveBriefView does exponential-backoff
  // polling). Errors are logged, not surfaced (the poll simply won't find data).
  const { id } = req.params;
  const userId = req.user.userId;
  objectiveAnalysisService.analyzeObjective(id, userId).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[objectiveController.analyzeObjective] background analysis failed:', err.message);
  });
  return res.status(202).json(apiResponse.success({ status: 'generating' }, 'Analysis started — building your competency map.'));
};

const getObjectiveBrief = async (req, res, next) => {
  try {
    const brief = await objectiveAnalysisService.getObjectiveBrief(req.params.id, req.user.userId);
    if (!brief) {
      return res.json(apiResponse.success(null, 'Objective not yet analyzed. Call POST /analyze first.'));
    }
    res.json(apiResponse.success(brief));
  } catch (err) { next(err); }
};

const activateObjective = async (req, res, next) => {
  try { res.json(apiResponse.success(await objectiveService.activateObjective(req.user.userId, req.params.id))); } catch (err) { next(err); }
};

const deepenObjective = async (req, res) => {
  try {
    const out = await objectiveService.deepenObjective(req.user.userId, req.params.id);
    require('../services/diagnosticTelemetryService').logEvent('ready.deepen', { userId: String(req.user.userId), objectiveId: req.params.id, newTarget: out.target });
    res.json(apiResponse.success(out, 'Bar raised — new plan on the way.'));
  } catch (err) {
    res.status(400).json(apiResponse.error(err.message));
  }
};

module.exports = { getObjectives, createObjective, updateObjective, pauseObjective, resumeObjective, setPrimary, deleteObjective, analyzeObjective, getObjectiveBrief, activateObjective, deepenObjective };
