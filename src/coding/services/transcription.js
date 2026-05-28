'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const s3 = require('../../config/s3');
const openai = require('../../config/openai');

/**
 * Lightweight audio-transcription helper for the capstone voice reflection
 * pipeline. Existing `workers/whisperTranscriber.js` is content-specific
 * (videos in the Content collection); we don't want to entangle the
 * capstone pipeline with that. This file is the minimum needed to:
 *
 *   1. Pull an S3 audio object → /tmp file
 *   2. Run it through Whisper (OpenAI)
 *   3. Return the transcript text + duration estimate
 *
 * The caller manages job orchestration (BullMQ) + downstream effects
 * (re-eval, Notes auto-gen).
 */

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI Whisper hard limit is 25 MB

class TranscriptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
  }
}

/**
 * Transcribe an audio file from S3.
 *
 * @param {string} s3Key
 * @returns {Promise<{ text: string, bytes: number, model: string }>}
 */
async function transcribeFromS3(s3Key) {
  const buf = await s3.downloadBuffer(s3Key);
  if (!buf || buf.length === 0) {
    throw new TranscriptionError('empty_audio', `audio object at ${s3Key} is empty or missing`);
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    throw new TranscriptionError('audio_too_large', `audio exceeds 25 MB Whisper cap`);
  }

  const ext = path.extname(s3Key) || '.m4a';
  const tmp = path.join(os.tmpdir(), `capstone-voice-${Date.now()}${ext}`);
  await fs.promises.writeFile(tmp, buf);

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmp),
      model: 'whisper-1',
      language: 'en',
      response_format: 'text',
    });
    const text = String(transcription || '').trim();
    if (text.length === 0) {
      throw new TranscriptionError('empty_transcript', 'Whisper returned an empty transcript');
    }
    return { text, bytes: buf.length, model: 'whisper-1' };
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

/** Convenience: transcribe directly from a Buffer (no S3 round-trip). */
async function transcribeBuffer(buf, { hintExt = '.m4a' } = {}) {
  if (!buf || buf.length === 0) {
    throw new TranscriptionError('empty_audio', 'buffer is empty');
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    throw new TranscriptionError('audio_too_large', 'audio exceeds 25 MB Whisper cap');
  }
  const tmp = path.join(os.tmpdir(), `capstone-voice-${Date.now()}${hintExt}`);
  await fs.promises.writeFile(tmp, buf);
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmp),
      model: 'whisper-1',
      language: 'en',
      response_format: 'text',
    });
    const text = String(transcription || '').trim();
    if (text.length === 0) {
      throw new TranscriptionError('empty_transcript', 'Whisper returned an empty transcript');
    }
    return { text, bytes: buf.length, model: 'whisper-1' };
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

module.exports = { transcribeFromS3, transcribeBuffer, TranscriptionError, MAX_AUDIO_BYTES };
// suppress unused require warning if Readable goes unused after future refactors
void Readable;
