const onboardingService = require('../services/onboardingService');
const apiResponse = require('../utils/apiResponse');

const getOnboardingStatus = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.getOnboardingStatus(req.user.userId))); } catch (err) { next(err); }
};
const updateProfile = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.updateProfile(req.user.userId, req.body))); } catch (err) { next(err); }
};
const updateBackground = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.updateBackground(req.user.userId, req.body))); } catch (err) { next(err); }
};
const setObjective = async (req, res, next) => {
  try { res.status(201).json(apiResponse.success(await onboardingService.setObjective(req.user.userId, req.body))); } catch (err) { next(err); }
};
const updatePreferences = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.updatePreferences(req.user.userId, req.body))); } catch (err) { next(err); }
};
const updateInterests = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.updateInterests(req.user.userId, req.body))); } catch (err) { next(err); }
};
const completeOnboarding = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.completeOnboarding(req.user.userId), 'Onboarding complete')); } catch (err) { next(err); }
};

module.exports = { getOnboardingStatus, updateProfile, updateBackground, setObjective, updatePreferences, updateInterests, completeOnboarding };
