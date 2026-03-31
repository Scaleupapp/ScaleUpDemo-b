const uploadService = require('../services/uploadService');
const contentService = require('../services/contentService');
const Content = require('../models/Content');
const User = require('../models/User');
const apiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// --- Upload ---

const requestUpload = async (req, res, next) => {
  try {
    const data = await uploadService.requestUpload({ creatorId: req.user.userId, ...req.body });
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const completeUpload = async (req, res, next) => {
  try {
    // Force contentType to 'notes'
    const content = await uploadService.completeUpload({
      creatorId: req.user.userId,
      ...req.body,
      contentType: 'notes',
    });

    // Auto-promote consumer → contributor on first notes upload
    const user = await User.findById(req.user.userId);
    if (user && user.role === 'consumer') {
      user.role = 'contributor';
      await user.save();
    }

    // Increment contributor stats
    await User.findByIdAndUpdate(req.user.userId, {
      $inc: { 'contributorStats.totalNotes': 1 },
    });

    res.status(201).json(apiResponse.success(content, 'Notes uploaded and processing'));
  } catch (err) { next(err); }
};

const requestThumbnailUpload = async (req, res, next) => {
  try {
    const data = await uploadService.requestThumbnailUpload({ creatorId: req.user.userId });
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const initiateMultipart = async (req, res, next) => {
  try {
    const data = await uploadService.initiateMultipart({ creatorId: req.user.userId, ...req.body });
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const completeMultipart = async (req, res, next) => {
  try {
    const data = await uploadService.completeMultipart(req.body);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const abortMultipart = async (req, res, next) => {
  try {
    const data = await uploadService.abortMultipart(req.body);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

// --- CRUD ---

const getMyNotes = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = { creatorId: req.user.userId, contentType: 'notes' };
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [notes, total] = await Promise.all([
      Content.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Content.countDocuments(filter),
    ]);

    res.json(apiResponse.success({
      items: notes,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
        hasNextPage: parseInt(page) < Math.ceil(total / parseInt(limit)),
        hasPrevPage: parseInt(page) > 1,
      },
    }));
  } catch (err) { next(err); }
};

const updateNote = async (req, res, next) => {
  try {
    const content = await Content.findOne({ _id: req.params.id, creatorId: req.user.userId, contentType: 'notes' });
    if (!content) throw new ApiError(404, 'Note not found');

    const allowedFields = ['title', 'description', 'domain', 'topics', 'tags', 'difficulty', 'collegeName', 'collegeId'];
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) content[key] = req.body[key];
    }
    await content.save();
    res.json(apiResponse.success(content));
  } catch (err) { next(err); }
};

const publishNote = async (req, res, next) => {
  try {
    const content = await Content.findOne({ _id: req.params.id, creatorId: req.user.userId, contentType: 'notes' });
    if (!content) throw new ApiError(404, 'Note not found');
    if (!['ready', 'unpublished'].includes(content.status)) {
      throw new ApiError(400, `Cannot publish note with status "${content.status}"`);
    }
    content.status = 'published';
    content.publishedAt = new Date();
    await content.save();
    res.json(apiResponse.success(content, 'Note published'));
  } catch (err) { next(err); }
};

const unpublishNote = async (req, res, next) => {
  try {
    const content = await Content.findOne({ _id: req.params.id, creatorId: req.user.userId, contentType: 'notes' });
    if (!content) throw new ApiError(404, 'Note not found');
    content.status = 'unpublished';
    await content.save();
    res.json(apiResponse.success(content, 'Note unpublished'));
  } catch (err) { next(err); }
};

const deleteNote = async (req, res, next) => {
  try {
    const content = await Content.findOne({ _id: req.params.id, creatorId: req.user.userId, contentType: 'notes' });
    if (!content) throw new ApiError(404, 'Note not found');
    await Content.deleteOne({ _id: content._id });
    await User.findByIdAndUpdate(req.user.userId, {
      $inc: { 'contributorStats.totalNotes': -1 },
    });
    res.json(apiResponse.success({ deleted: true }));
  } catch (err) { next(err); }
};

module.exports = {
  requestUpload, completeUpload, requestThumbnailUpload,
  initiateMultipart, completeMultipart, abortMultipart,
  getMyNotes, updateNote, publishNote, unpublishNote, deleteNote,
};
