const noteRequestService = require('../services/noteRequestService');
const apiResponse = require('../utils/apiResponse');

const createRequest = async (req, res, next) => {
  try {
    const data = await noteRequestService.createRequest(req.user.userId, req.body);
    res.status(201).json(apiResponse.success(data, 'Note request created'));
  } catch (err) { next(err); }
};

const listRequests = async (req, res, next) => {
  try {
    const data = await noteRequestService.listRequests(req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const getMyRequests = async (req, res, next) => {
  try {
    const data = await noteRequestService.getMyRequests(req.user.userId, req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const getRequest = async (req, res, next) => {
  try {
    const data = await noteRequestService.getRequest(req.params.id);
    const isUpvoted = await noteRequestService.isUpvotedByUser(req.user.userId, req.params.id);
    res.json(apiResponse.success({ ...data, isUpvotedByMe: isUpvoted }));
  } catch (err) { next(err); }
};

const toggleUpvote = async (req, res, next) => {
  try {
    const data = await noteRequestService.toggleUpvote(req.user.userId, req.params.id);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const claimRequest = async (req, res, next) => {
  try {
    const data = await noteRequestService.claimRequest(req.user.userId, req.params.id);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const fulfillRequest = async (req, res, next) => {
  try {
    const { contentId } = req.body;
    if (!contentId) return res.status(400).json(apiResponse.error('contentId is required'));
    const data = await noteRequestService.fulfillRequest(req.user.userId, req.params.id, contentId);
    res.json(apiResponse.success(data, 'Request fulfilled'));
  } catch (err) { next(err); }
};

const deleteRequest = async (req, res, next) => {
  try {
    const data = await noteRequestService.deleteRequest(req.user.userId, req.params.id);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

module.exports = { createRequest, listRequests, getMyRequests, getRequest, toggleUpvote, claimRequest, fulfillRequest, deleteRequest };
