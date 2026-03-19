const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const openai = require('../config/openai');
const Content = require('../models/Content');
const { s3 } = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');

const execFileAsync = promisify(execFile);
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

/**
 * Whisper Transcription Worker
 *
 * Processes content items that have no transcript.
 * - YouTube: Downloads audio via ytdl-core
 * - Original uploads: Downloads from S3, extracts audio with ffmpeg
 * Then sends to OpenAI Whisper → stores transcript → re-queues for AI analysis.
 *
 * Cost: ~$0.006/minute of audio. A 10-min video ≈ $0.06.
 */
async function transcribeContent(job) {
  const { contentId } = job.data;
  const content = await Content.findById(contentId);
  if (!content) return;

  // Skip if transcript already exists
  if (content.transcript && content.transcript.trim().length > 0) {
    return { status: 'skipped', reason: 'transcript_exists' };
  }

  // Skip non-video content
  if (content.contentType !== 'video') {
    return { status: 'skipped', reason: 'not_video' };
  }

  const tmpDir = os.tmpdir();
  const timestamp = Date.now();
  let tmpVideoFile = null;
  let tmpAudioFile = null;

  try {
    if (content.youtubeVideoId) {
      // --- YouTube path ---
      tmpAudioFile = path.join(tmpDir, `scaleup-audio-yt-${content.youtubeVideoId}-${timestamp}.mp4`);
      await downloadYoutubeAudio(content.youtubeVideoId, tmpAudioFile, job);
    } else if (content.s3Key) {
      // --- Original upload path: download from S3, extract audio with ffmpeg ---
      const ext = path.extname(content.s3Key) || '.mp4';
      tmpVideoFile = path.join(tmpDir, `scaleup-video-${contentId}-${timestamp}${ext}`);
      tmpAudioFile = path.join(tmpDir, `scaleup-audio-${contentId}-${timestamp}.mp3`);

      await job.updateProgress(5);
      await downloadFromS3(content.s3Key, tmpVideoFile);
      await job.updateProgress(30);

      // Extract audio: mono, 16kHz, 64kbps — keeps file small for Whisper
      await execFileAsync(FFMPEG_PATH, [
        '-i', tmpVideoFile,
        '-vn',                    // no video
        '-ac', '1',               // mono
        '-ar', '16000',           // 16kHz sample rate
        '-b:a', '64k',           // 64kbps bitrate
        '-f', 'mp3',
        '-y',                     // overwrite
        tmpAudioFile,
      ], { timeout: 300000 }); // 5 min timeout for extraction

      await job.updateProgress(50);
    } else {
      return { status: 'skipped', reason: 'no_source' };
    }

    // Check file size — Whisper has a 25MB limit
    const stats = fs.statSync(tmpAudioFile);
    if (stats.size > 25 * 1024 * 1024) {
      return { status: 'skipped', reason: 'audio_too_large', sizeMB: (stats.size / 1024 / 1024).toFixed(1) };
    }
    if (stats.size < 1024) {
      return { status: 'skipped', reason: 'audio_too_small' };
    }

    // Send to Whisper
    await job.updateProgress(60);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpAudioFile),
      model: 'whisper-1',
      language: 'en',
      response_format: 'text',
    });

    await job.updateProgress(90);

    if (!transcription || transcription.trim().length === 0) {
      return { status: 'failed', reason: 'empty_transcription' };
    }

    // Store transcript
    content.transcript = transcription;
    await content.save();

    // Re-queue for AI processing with the transcript
    const { contentProcessingQueue } = require('../config/queue');
    await contentProcessingQueue.add('process', { contentId: content._id.toString() });

    await job.updateProgress(100);
    return { status: 'completed', transcriptLength: transcription.length };

  } catch (err) {
    if (err.message?.includes('Video unavailable') || err.message?.includes('private video')) {
      return { status: 'skipped', reason: 'video_unavailable' };
    }
    if (err.message?.includes('age-restricted')) {
      return { status: 'skipped', reason: 'age_restricted' };
    }
    throw err; // Let BullMQ retry for transient errors
  } finally {
    // Clean up temp files
    if (tmpVideoFile) try { fs.unlinkSync(tmpVideoFile); } catch { /* ignore */ }
    if (tmpAudioFile) try { fs.unlinkSync(tmpAudioFile); } catch { /* ignore */ }
  }
}

// --- Helpers ---

async function downloadYoutubeAudio(videoId, outputPath, job) {
  const ytdl = require('ytdl-core');
  await job.updateProgress(10);
  const audioStream = ytdl(`https://youtube.com/watch?v=${videoId}`, {
    quality: 'lowestaudio',
    filter: 'audioonly',
  });
  const writeStream = fs.createWriteStream(outputPath);
  await pipeline(audioStream, writeStream);
  await job.updateProgress(50);
}

async function downloadFromS3(key, outputPath) {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
  });
  const response = await s3.send(command);
  const writeStream = fs.createWriteStream(outputPath);
  await pipeline(response.Body, writeStream);
}

module.exports = transcribeContent;
