const openai = require('../config/openai');
const Content = require('../models/Content');
const AudioSummary = require('../models/AudioSummary');
const { uploadBuffer } = require('../config/s3');
const { s3 } = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const ApiError = require('../utils/apiError');

class AudioSummaryService {

  async generate(contentId) {
    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');

    // Check if already exists and ready
    const existing = await AudioSummary.findOne({ contentId, status: 'ready' });
    if (existing) return existing;

    // Check if already generating
    const generating = await AudioSummary.findOne({ contentId, status: 'generating' });
    if (generating) return generating;

    const summaryText = content.aiData?.summary;
    if (!summaryText || summaryText.length < 20) {
      throw new ApiError(400, 'Content has no AI summary to convert to audio');
    }

    const s3Key = `audio-summaries/${contentId}.mp3`;

    // Create placeholder
    const audioSummary = await AudioSummary.create({
      contentId,
      s3Key,
      status: 'generating',
    });

    try {
      // Call OpenAI TTS
      const response = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: summaryText,
      });

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Upload to S3
      await uploadBuffer(s3Key, buffer, 'audio/mpeg');

      // Estimate duration: TTS-1 speaks at ~150 words/min
      const wordCount = summaryText.split(/\s+/).length;
      const estimatedDuration = Math.round((wordCount / 150) * 60);

      audioSummary.status = 'ready';
      audioSummary.generatedAt = new Date();
      audioSummary.fileSize = buffer.length;
      audioSummary.duration = estimatedDuration;
      await audioSummary.save();

      return audioSummary;
    } catch (err) {
      audioSummary.status = 'failed';
      await audioSummary.save();
      throw err;
    }
  }

  async getAudioURL(contentId) {
    const audioSummary = await AudioSummary.findOne({ contentId, status: 'ready' });
    if (!audioSummary) throw new ApiError(404, 'Audio summary not found');

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: audioSummary.s3Key,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

    return {
      url,
      duration: audioSummary.duration,
      voice: audioSummary.voice,
      fileSize: audioSummary.fileSize,
    };
  }

  async getStatus(contentId) {
    const audioSummary = await AudioSummary.findOne({ contentId });
    if (!audioSummary) return { status: 'not_found' };
    return { status: audioSummary.status };
  }
}

module.exports = new AudioSummaryService();
