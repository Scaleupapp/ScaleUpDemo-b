'use strict';
/**
 * capstoneAuthoringSupport.js
 *
 * Extracted helper that creates a CapstoneGenerationRequest and enqueues it.
 * Used by both the D2C capstones controller (generateCapstone) and the
 * institution assessmentAuthoringService (authorCapstone).
 */

/**
 * Create a generation request doc and enqueue it for processing.
 *
 * On success, returns the created reqDoc.
 * On enqueue failure:
 *   - marks reqDoc.status = 'failed' (best-effort)
 *   - re-throws the enqueue error so the caller can handle it (e.g. return 503)
 *
 * @param {{ userId, roleTrack, difficulty, language, jobDescription, topicHint }} params
 * @param {object} deps  - injectable: { CapstoneGenerationRequest, capstoneGenerationWorker }
 * @returns {Promise<object>} reqDoc
 */
async function requestGeneration(
  { userId, roleTrack, difficulty, language, jobDescription, topicHint },
  deps = {}
) {
  const CapstoneGenerationRequest =
    deps.CapstoneGenerationRequest ||
    require('../models/capstoneGenerationRequest.model');
  const capstoneGenerationWorker =
    deps.capstoneGenerationWorker ||
    require('../workers/capstoneGeneration.worker');

  const reqDoc = await CapstoneGenerationRequest.create({
    user_id: userId,
    job_description: jobDescription || '',
    topic_hint: topicHint || '',
    role_track: roleTrack,
    difficulty,
    language,
    status: 'queued',
  });

  try {
    await capstoneGenerationWorker.enqueueGeneration(reqDoc._id);
  } catch (enqueueErr) {
    // Mark the request failed (best-effort) so it doesn't hang in 'queued' forever
    await CapstoneGenerationRequest.findByIdAndUpdate(reqDoc._id, {
      $set: { status: 'failed', error: 'Could not queue generation. Try again shortly.' },
    }).catch(() => {});
    throw enqueueErr;
  }

  return reqDoc;
}

module.exports = { requestGeneration };
