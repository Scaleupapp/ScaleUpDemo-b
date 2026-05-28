'use strict';

const multer = require('multer');
const s3 = require('../../config/s3');
const CapstoneSession = require('../models/capstoneSession.model');
const voiceReflectionWorker = require('../workers/voiceReflection.worker');
const { MAX_AUDIO_BYTES } = require('../services/transcription');

/**
 * Voice-reflection upload controller (spec §7.2 step 12).
 *
 * Multer in-memory upload → S3 → enqueue transcription job → 202 to client.
 * The worker does the heavy lifting (Whisper + Sonnet re-score). Mobile
 * polls /capstones/:id/result and sees the updated graded_at when the
 * worker finishes.
 *
 * Validation:
 *   - audio MIME must start with 'audio/' (m4a, mp3, wav, webm all OK)
 *   - cap at 25 MB (Whisper's hard limit; multer enforces upstream)
 *   - session must belong to caller AND be in `graded` state (we expect
 *     the reflection to be recorded post-result-screen)
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_AUDIO_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('audio/')) {
      cb(new Error('audio/* mimetype required'));
      return;
    }
    cb(null, true);
  },
});

/** Express middleware — single 'audio' file. */
const audioUpload = upload.single('audio');

async function uploadVoiceReflection(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'audio file required (multipart field "audio")' });
  }

  const session = await CapstoneSession.findOne({
    _id: req.params.session_id,
    user_id: req.user.userId,
  });
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (session.status !== 'graded') {
    return res.status(409).json({ error: 'session_not_graded', current_status: session.status });
  }

  // Idempotency: if a transcript is already present, reject so the user
  // explicitly knows they're overwriting. Mobile can re-confirm and pass
  // a `replace=true` flag (handled below).
  if (session.voice_reflection_transcript && req.query.replace !== 'true') {
    return res.status(409).json({
      error: 'reflection_already_recorded',
      message: 'Pass ?replace=true to overwrite the existing reflection.',
    });
  }

  const ext = mapMimeToExt(req.file.mimetype) || '.m4a';
  const s3Key = `capstone-voice-reflections/${session._id}/reflection${ext}`;

  await s3.uploadBuffer(s3Key, req.file.buffer, req.file.mimetype);

  await CapstoneSession.findByIdAndUpdate(session._id, {
    $set: {
      voice_reflection_s3_key: s3Key,
      // Clear any prior transcript so the worker re-transcribes the new audio.
      voice_reflection_transcript: null,
    },
  });

  // Enqueue. Job is idempotent on jobId so duplicate uploads collapse to one.
  await voiceReflectionWorker.enqueueTranscription(session._id);

  res.status(202).json({
    session_id: String(session._id),
    bytes: req.file.size,
    queued: true,
  });
}

function mapMimeToExt(mime) {
  switch (mime) {
    case 'audio/m4a':
    case 'audio/x-m4a':
    case 'audio/mp4':
      return '.m4a';
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'audio/webm':
      return '.webm';
    case 'audio/ogg':
      return '.ogg';
    default:
      return null;
  }
}

module.exports = {
  audioUpload,
  uploadVoiceReflection,
};
