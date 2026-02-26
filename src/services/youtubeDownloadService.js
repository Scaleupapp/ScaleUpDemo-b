const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { uploadStream, uploadBuffer } = require('../config/s3');

class YouTubeDownloadService {

  /**
   * Download a YouTube video using yt-dlp and upload to S3.
   *
   * yt-dlp is far more reliable than any Node.js YouTube library because it
   * actively keeps up with YouTube's anti-bot changes.
   *
   * Flow: yt-dlp downloads to temp file → we stream the file to S3 → cleanup.
   *
   * Returns { videoS3URL, videoS3Key }.
   */
  async downloadAndUploadVideo(videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const s3Key = `youtube/${videoId}/${crypto.randomUUID()}.mp4`;
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `yt-${videoId}-${Date.now()}.mp4`);

    try {
      // Download using yt-dlp — 480p max to keep file sizes manageable
      const ffmpegPath = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
      await this._runYtDlp([
        '-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]',
        '--merge-output-format', 'mp4',
        '--ffmpeg-location', ffmpegPath,
        '-o', tmpFile,
        '--no-playlist',
        '--no-warnings',
        url,
      ]);

      // Stream the downloaded file to S3
      const fileStream = fs.createReadStream(tmpFile);
      const videoS3URL = await uploadStream(s3Key, fileStream, 'video/mp4');

      return { videoS3URL, videoS3Key: s3Key };
    } finally {
      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  /**
   * Download a thumbnail image and upload it to S3.
   * Thumbnails are small, so we buffer them.
   * Returns { thumbnailS3URL, thumbnailS3Key }.
   */
  async downloadAndUploadThumbnail(videoId, thumbnailURL) {
    if (!thumbnailURL) return { thumbnailS3URL: null, thumbnailS3Key: null };

    const ext = thumbnailURL.includes('.png') ? 'png' : 'jpg';
    const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
    const s3Key = `youtube/${videoId}/thumbnail.${ext}`;

    const buffer = await this._downloadToBuffer(thumbnailURL);
    const thumbnailS3URL = await uploadBuffer(s3Key, buffer, contentType);

    return { thumbnailS3URL, thumbnailS3Key: s3Key };
  }

  /**
   * Run yt-dlp as a child process. Returns a promise that resolves on exit 0.
   */
  _runYtDlp(args) {
    return new Promise((resolve, reject) => {
      const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
      execFile(ytdlpPath, args, { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`yt-dlp failed: ${err.message}\n${stderr}`));
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Download a URL to a Buffer (for small files like thumbnails).
   */
  _downloadToBuffer(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      client.get(url, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._downloadToBuffer(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download thumbnail: HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }
}

module.exports = new YouTubeDownloadService();
