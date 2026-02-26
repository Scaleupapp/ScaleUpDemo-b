const creatorService = require('../services/creatorService');
const apiResponse = require('../utils/apiResponse');

const apply = async (req, res, next) => {
  try {
    const app = await creatorService.apply(req.user.userId, req.body);
    res.status(201).json(apiResponse.success(app, 'Application submitted. Awaiting endorsement from core/anchor creators.'));
  } catch (err) { next(err); }
};

const getMyApplication = async (req, res, next) => {
  try {
    const app = await creatorService.getMyApplication(req.user.userId);
    res.json(apiResponse.success(app));
  } catch (err) { next(err); }
};

const getMyProfile = async (req, res, next) => {
  try {
    const profile = await creatorService.getMyProfile(req.user.userId);
    res.json(apiResponse.success(profile));
  } catch (err) { next(err); }
};

const updateProfile = async (req, res, next) => {
  try {
    const profile = await creatorService.updateProfile(req.user.userId, req.body);
    res.json(apiResponse.success(profile));
  } catch (err) { next(err); }
};

// Core/anchor creators endorse a pending application
const endorseApplication = async (req, res, next) => {
  try {
    const app = await creatorService.endorseApplication(req.user.userId, req.params.applicationId, req.body);
    res.json(apiResponse.success(app, app.status === 'approved' ? 'Application approved!' : 'Endorsement added'));
  } catch (err) { next(err); }
};

// Browse pending applications (for core/anchor creators to find people to endorse)
const getPendingApplications = async (req, res, next) => {
  try {
    const data = await creatorService.getPendingApplications(req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

// Search for creators on the platform
const searchCreators = async (req, res, next) => {
  try {
    const data = await creatorService.searchCreators(req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

module.exports = { apply, getMyApplication, getMyProfile, updateProfile, endorseApplication, getPendingApplications, searchCreators };
