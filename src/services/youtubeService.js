const { google } = require('googleapis');
const { YoutubeTranscript } = require('youtube-transcript');
const Content = require('../models/Content');
const YouTubeImport = require('../models/YouTubeImport');
const { contentProcessingQueue } = require('../config/queue');
const youtubeDownloadService = require('./youtubeDownloadService');

const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });

class YouTubeService {

  _parseDuration(iso) {
    if (!iso) return 0;
    const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    return (parseInt(match[1] || '0') * 3600) +
           (parseInt(match[2] || '0') * 60) +
           parseInt(match[3] || '0');
  }

  async fetchVideoDetails(videoId) {
    const res = await youtube.videos.list({
      part: 'snippet,contentDetails,statistics',
      id: videoId,
    });
    if (!res.data.items || res.data.items.length === 0) {
      throw new Error(`YouTube video not found: ${videoId}`);
    }
    return res.data.items[0];
  }

  async fetchChannelVideos(channelId, maxResults = 50) {
    const videoIds = [];
    let pageToken = null;
    let remaining = maxResults;

    while (remaining > 0) {
      const res = await youtube.search.list({
        part: 'id',
        channelId,
        type: 'video',
        order: 'date',
        maxResults: Math.min(remaining, 50),
        pageToken: pageToken || undefined,
      });
      for (const item of (res.data.items || [])) {
        if (item.id?.videoId) videoIds.push(item.id.videoId);
      }
      remaining -= (res.data.items || []).length;
      pageToken = res.data.nextPageToken;
      if (!pageToken) break;
    }
    return videoIds;
  }

  async fetchPlaylistVideos(playlistId) {
    const videoIds = [];
    let pageToken = null;

    do {
      const res = await youtube.playlistItems.list({
        part: 'contentDetails',
        playlistId,
        maxResults: 50,
        pageToken: pageToken || undefined,
      });
      for (const item of (res.data.items || [])) {
        if (item.contentDetails?.videoId) videoIds.push(item.contentDetails.videoId);
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    return videoIds;
  }

  async searchVideos(query, maxResults = 20) {
    const res = await youtube.search.list({
      part: 'id,snippet',
      q: query,
      type: 'video',
      maxResults: Math.min(maxResults, 50),
    });
    return res.data.items || [];
  }

  async fetchTranscript(videoId) {
    try {
      const segments = await YoutubeTranscript.fetchTranscript(videoId);
      if (!segments || segments.length === 0) return null;
      return segments.map(s => s.text).join(' ');
    } catch {
      return null;
    }
  }

  async importVideo({ videoId, domain, topics, importedBy }) {
    const existing = await Content.findOne({ youtubeVideoId: videoId });
    if (existing) return existing;

    const videoData = await this.fetchVideoDetails(videoId);
    const transcript = await this.fetchTranscript(videoId);
    const { snippet, contentDetails } = videoData;

    const thumbs = snippet.thumbnails || {};
    const originalThumbnailURL = thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url;

    // Download video from YouTube and upload to S3
    const { videoS3URL, videoS3Key } = await youtubeDownloadService.downloadAndUploadVideo(videoId);

    // Download thumbnail and upload to S3
    const { thumbnailS3URL, thumbnailS3Key } = await youtubeDownloadService.downloadAndUploadThumbnail(videoId, originalThumbnailURL);

    const content = await Content.create({
      // creatorId is intentionally null for YouTube imports — we don't claim ownership
      creatorId: null,
      title: snippet.title,
      description: snippet.description,
      contentType: 'video',
      contentURL: videoS3URL,
      s3Key: videoS3Key,
      thumbnailURL: thumbnailS3URL || originalThumbnailURL,
      thumbnailS3Key: thumbnailS3Key || null,
      duration: this._parseDuration(contentDetails.duration),

      // Source attribution — makes it legally clear this is YouTube content
      sourceType: 'youtube',
      sourceAttribution: {
        platform: 'YouTube',
        originalCreatorName: snippet.channelTitle,
        originalCreatorUrl: `https://youtube.com/channel/${snippet.channelId}`,
        originalContentUrl: `https://youtube.com/watch?v=${videoId}`,
        importDisclaimer: 'This content is sourced from YouTube for educational purposes. All rights belong to the original creator.',
      },

      youtubeVideoId: videoId,
      youtubeChannelId: snippet.channelId,
      youtubeChannelTitle: snippet.channelTitle,
      transcript: transcript || '',
      isYoutubeImport: true,
      domain,
      topics: topics || [],
      status: 'processing',
      aiStatus: 'pending',
    });

    await contentProcessingQueue.add('process', { contentId: content._id.toString() });
    return content;
  }

  async importChannel({ channelId, domain, topics, importedBy, maxVideos = 50 }) {
    const videoIds = await this.fetchChannelVideos(channelId, maxVideos);
    const channelInfo = await youtube.channels.list({ part: 'snippet', id: channelId });
    const channelName = channelInfo.data.items?.[0]?.snippet?.title || channelId;

    const importDoc = await YouTubeImport.create({
      importedBy,
      sourceType: 'channel',
      sourceId: channelId,
      sourceName: channelName,
      domain,
      defaultTopics: topics || [],
      videosFound: videoIds.length,
      status: 'in_progress',
      startedAt: new Date(),
    });

    for (const vid of videoIds) {
      try {
        const content = await this.importVideo({ videoId: vid, domain, topics, importedBy });
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
    }

    importDoc.status = importDoc.videosFailed > 0 ? 'partial' : 'completed';
    importDoc.completedAt = new Date();
    await importDoc.save();
    return importDoc;
  }

  async importPlaylist({ playlistId, domain, topics, importedBy }) {
    const videoIds = await this.fetchPlaylistVideos(playlistId);

    const importDoc = await YouTubeImport.create({
      importedBy,
      sourceType: 'playlist',
      sourceId: playlistId,
      domain,
      defaultTopics: topics || [],
      videosFound: videoIds.length,
      status: 'in_progress',
      startedAt: new Date(),
    });

    for (const vid of videoIds) {
      try {
        const content = await this.importVideo({ videoId: vid, domain, topics, importedBy });
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
    }

    importDoc.status = importDoc.videosFailed > 0 ? 'partial' : 'completed';
    importDoc.completedAt = new Date();
    await importDoc.save();
    return importDoc;
  }
}

module.exports = new YouTubeService();
