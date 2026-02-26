const youtubeService = require('../services/youtubeService');
const YouTubeImport = require('../models/YouTubeImport');
const apiResponse = require('../utils/apiResponse');

const importVideo = async (req, res, next) => {
  try {
    const { videoId, domain, topics } = req.body;
    const content = await youtubeService.importVideo({
      videoId, domain, topics, importedBy: req.user.userId,
    });
    res.status(201).json(apiResponse.success(content, 'Video imported and queued for AI processing'));
  } catch (err) { next(err); }
};

const importChannel = async (req, res, next) => {
  try {
    const { channelId, domain, topics, maxVideos } = req.body;
    const result = await youtubeService.importChannel({
      channelId, domain, topics, importedBy: req.user.userId, maxVideos,
    });
    res.status(201).json(apiResponse.success(result, 'Channel import completed'));
  } catch (err) { next(err); }
};

const importPlaylist = async (req, res, next) => {
  try {
    const { playlistId, domain, topics } = req.body;
    const result = await youtubeService.importPlaylist({
      playlistId, domain, topics, importedBy: req.user.userId,
    });
    res.status(201).json(apiResponse.success(result, 'Playlist import completed'));
  } catch (err) { next(err); }
};

const searchVideos = async (req, res, next) => {
  try {
    const { q, maxResults } = req.query;
    const results = await youtubeService.searchVideos(q, parseInt(maxResults) || 20);
    res.json(apiResponse.success(results));
  } catch (err) { next(err); }
};

const listImports = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const imports = await YouTubeImport.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
    const total = await YouTubeImport.countDocuments();
    res.json(apiResponse.paginated(imports, { total, page, limit, totalPages: Math.ceil(total / limit) }));
  } catch (err) { next(err); }
};

module.exports = { importVideo, importChannel, importPlaylist, searchVideos, listImports };
