const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const openai = require('../config/openai');
const Content = require('../models/Content');

/**
 * Whisper Transcription Worker
 *
 * Processes content items that have no transcript.
 * Downloads audio via ytdl-core → sends to OpenAI Whisper → stores transcript.
 * After transcription, re-queues the content for AI processing if needed.
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

  // Only process YouTube content for now
  if (!content.youtubeVideoId) {
    return { status: 'skipped', reason: 'not_youtube' };
  }

  const tmpFile = path.join(os.tmpdir(), `scaleup-audio-${content.youtubeVideoId}-${Date.now()}.mp4`);

  try {
    // Dynamic import — ytdl-core uses ESM-compatible patterns
    const ytdl = require('ytdl-core');

    // Download audio-only stream
    await job.updateProgress(10);
    const audioStream = ytdl(`https://youtube.com/watch?v=${content.youtubeVideoId}`, {
      quality: 'lowestaudio',
      filter: 'audioonly',
    });

    // Pipe to temp file
    const writeStream = fs.createWriteStream(tmpFile);
    await pipeline(audioStream, writeStream);
    await job.updateProgress(50);

    // Check file size — Whisper has a 25MB limit
    const stats = fs.statSync(tmpFile);
    if (stats.size > 25 * 1024 * 1024) {
      // File too large — skip for now (could chunk in future)
      return { status: 'skipped', reason: 'file_too_large', sizeMB: (stats.size / 1024 / 1024).toFixed(1) };
    }

    if (stats.size < 1024) {
      return { status: 'skipped', reason: 'file_too_small' };
    }

    // Send to Whisper
    await job.updateProgress(60);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
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

    // If AI hasn't processed yet or used description fallback, re-queue for AI processing
    if (content.aiStatus === 'pending' || content.aiStatus === 'failed') {
      const { contentProcessingQueue } = require('../config/queue');
      await contentProcessingQueue.add('process', { contentId: content._id.toString() });
    }

    await job.updateProgress(100);
    return { status: 'completed', transcriptLength: transcription.length };

  } catch (err) {
    // Specific error handling
    if (err.message?.includes('Video unavailable') || err.message?.includes('private video')) {
      return { status: 'skipped', reason: 'video_unavailable' };
    }
    if (err.message?.includes('age-restricted')) {
      return { status: 'skipped', reason: 'age_restricted' };
    }
    throw err; // Let BullMQ retry for transient errors
  } finally {
    // Always clean up temp file
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

module.exports = transcribeContent;
