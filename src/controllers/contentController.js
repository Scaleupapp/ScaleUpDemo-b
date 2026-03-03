const uploadService = require('../services/uploadService');
const contentService = require('../services/contentService');
const socialService = require('../services/socialService');
const apiResponse = require('../utils/apiResponse');
const { s3 } = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const requestUpload = async (req, res, next) => {
  try {
    const data = await uploadService.requestUpload({ creatorId: req.user.userId, ...req.body });
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const completeUpload = async (req, res, next) => {
  try {
    const content = await uploadService.completeUpload({ creatorId: req.user.userId, ...req.body });
    res.status(201).json(apiResponse.success(content, 'Content uploaded and processing'));
  } catch (err) { next(err); }
};

const getMyContent = async (req, res, next) => {
  try {
    const data = await contentService.getMyContent(req.user.userId, req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const updateContent = async (req, res, next) => {
  try {
    const content = await contentService.updateContent(req.user.userId, req.params.id, req.body);
    res.json(apiResponse.success(content));
  } catch (err) { next(err); }
};

const publishContent = async (req, res, next) => {
  try {
    const content = await contentService.publishContent(req.user.userId, req.params.id);
    res.json(apiResponse.success(content, 'Content published'));
  } catch (err) { next(err); }
};

const unpublishContent = async (req, res, next) => {
  try {
    const content = await contentService.unpublishContent(req.user.userId, req.params.id);
    res.json(apiResponse.success(content, 'Content unpublished'));
  } catch (err) { next(err); }
};

const deleteContent = async (req, res, next) => {
  try {
    const result = await contentService.deleteContent(req.user.userId, req.params.id);
    res.json(apiResponse.success(result, 'Content deleted'));
  } catch (err) { next(err); }
};

const getFeed = async (req, res, next) => {
  try {
    const recommendationService = require('../services/recommendationService');
    const data = await recommendationService.getPersonalizedFeed(req.user.userId, req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const explore = async (req, res, next) => {
  try {
    const data = await contentService.explore(req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const getContent = async (req, res, next) => {
  try {
    const content = await contentService.getContent(req.params.id);
    res.json(apiResponse.success(content));
  } catch (err) { next(err); }
};

const getLikedContent = async (req, res, next) => {
  try {
    const data = await socialService.getLikedContent(req.user.userId, req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const getSavedContent = async (req, res, next) => {
  try {
    const data = await socialService.getSavedContent(req.user.userId, req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const toggleLike = async (req, res, next) => {
  try {
    const result = await socialService.toggleLike(req.user.userId, req.params.id);
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

const toggleSave = async (req, res, next) => {
  try {
    const result = await socialService.toggleSave(req.user.userId, req.params.id);
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

const rateContent = async (req, res, next) => {
  try {
    const result = await socialService.rateContent(req.user.userId, req.params.id, req.body.value);
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

const getComments = async (req, res, next) => {
  try {
    const data = await socialService.getComments(req.params.id, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const addComment = async (req, res, next) => {
  try {
    const comment = await socialService.addComment(req.user.userId, req.params.id, req.body);
    res.status(201).json(apiResponse.success(comment));
  } catch (err) { next(err); }
};

const trackShare = async (req, res, next) => {
  try {
    const result = await socialService.trackShare(req.user.userId, req.params.id);
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

const reportContent = async (req, res, next) => {
  try {
    const ContentReport = require('../models/ContentReport');
    const Content = require('../models/Content');
    const { reason, description } = req.body;
    if (!reason) return res.status(400).json(apiResponse.error('Report reason is required'));

    const existing = await ContentReport.findOne({ contentId: req.params.id, reporterId: req.user.userId });
    if (existing) return res.status(409).json(apiResponse.error('You have already reported this content'));

    await ContentReport.create({ contentId: req.params.id, reporterId: req.user.userId, reason, description });
    await Content.findByIdAndUpdate(req.params.id, { $inc: { reportCount: 1 } });
    res.json(apiResponse.success(null, 'Content reported'));
  } catch (err) { next(err); }
};

const getStreamUrl = async (req, res, next) => {
  try {
    const content = await contentService.getContent(req.params.id);
    if (!content || !content.s3Key) {
      return res.status(404).json(apiResponse.error('Content not found or no video available'));
    }
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: content.s3Key,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json(apiResponse.success({ url }));
  } catch (err) { next(err); }
};

module.exports = {
  requestUpload, completeUpload, getMyContent, updateContent, publishContent, unpublishContent, deleteContent,
  getFeed, explore, getContent, getStreamUrl, getLikedContent, getSavedContent, toggleLike, toggleSave, rateContent, trackShare, getComments, addComment, reportContent,
};
