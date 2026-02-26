const aiTutorService = require('../services/aiTutorService');
const apiResponse = require('../utils/apiResponse');

const getConversation = async (req, res, next) => {
  try {
    const data = await aiTutorService.getConversation(req.user.userId, req.params.contentId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const sendMessage = async (req, res, next) => {
  try {
    const data = await aiTutorService.sendMessage(req.user.userId, req.params.contentId, req.body.message);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const listConversations = async (req, res, next) => {
  try {
    const data = await aiTutorService.listConversations(req.user.userId, req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const deleteConversation = async (req, res, next) => {
  try {
    const data = await aiTutorService.deleteConversation(req.user.userId, req.params.contentId);
    res.json(apiResponse.success(data, 'Conversation deleted'));
  } catch (err) { next(err); }
};

const getTutorStatus = async (req, res, next) => {
  try {
    const data = await aiTutorService.getTutorStatus(req.params.contentId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

module.exports = { getConversation, sendMessage, listConversations, deleteConversation, getTutorStatus };
