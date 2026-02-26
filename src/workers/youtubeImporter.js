const youtubeService = require('../services/youtubeService');
const YouTubeImport = require('../models/YouTubeImport');

async function processYoutubeImport(job) {
  const { importId, sourceType, sourceId, domain, topics, importedBy, maxVideos } = job.data;

  const importDoc = await YouTubeImport.findById(importId);
  if (!importDoc) throw new Error(`Import doc not found: ${importId}`);

  importDoc.status = 'in_progress';
  importDoc.startedAt = new Date();
  await importDoc.save();

  try {
    let videoIds = [];
    if (sourceType === 'channel') {
      videoIds = await youtubeService.fetchChannelVideos(sourceId, maxVideos || 50);
    } else if (sourceType === 'playlist') {
      videoIds = await youtubeService.fetchPlaylistVideos(sourceId);
    }

    importDoc.videosFound = videoIds.length;
    await importDoc.save();

    for (let i = 0; i < videoIds.length; i++) {
      const vid = videoIds[i];
      try {
        const content = await youtubeService.importVideo({
          videoId: vid, domain, topics, importedBy,
        });
        importDoc.videosImported += 1;
        importDoc.importedContentIds.push(content._id);
      } catch (err) {
        if (err.message?.includes('already')) {
          importDoc.videosSkipped += 1;
        } else {
          importDoc.videosFailed += 1;
          importDoc.errors.push({ videoId: vid, error: err.message });
        }
      }
      await importDoc.save();
      await job.updateProgress(Math.round(((i + 1) / videoIds.length) * 100));
    }

    importDoc.status = importDoc.videosFailed > 0 ? 'partial' : 'completed';
    importDoc.completedAt = new Date();
    await importDoc.save();
  } catch (err) {
    importDoc.status = 'failed';
    importDoc.errors.push({ videoId: 'bulk', error: err.message });
    await importDoc.save();
    throw err;
  }
}

module.exports = processYoutubeImport;
