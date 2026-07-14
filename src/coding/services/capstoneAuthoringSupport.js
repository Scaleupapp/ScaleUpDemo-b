'use strict';
/**
 * capstoneAuthoringSupport.js
 *
 * Extracted helper that creates a CapstoneGenerationRequest and enqueues it.
 * Used by both the D2C capstones controller (generateCapstone) and the
 * institution assessmentAuthoringService (authorCapstone).
 *
 * Ownership: the caller passes EXACTLY ONE of `userId` (D2C — one student
 * generating their own capstone) or `institutionId` (institution — a TPO /
 * author agent authoring a capstone for a cohort, which has no single
 * student owner). `cohortId` / `assessmentId` / `requestedByInstitutionUserId`
 * are optional enrichment carried alongside `institutionId`, never a
 * substitute for it. Whichever mode is given is persisted onto the matching
 * new fields on CapstoneGenerationRequest — an InstitutionUser id must NEVER
 * land in `user_id` (that was the original bug: assessment.createdBy, an
 * InstitutionUser id, was being passed as `userId` here). The model's own
 * pre('validate') hook is the final backstop if a caller gets this wrong.
 */

/**
 * Create a generation request doc and enqueue it for processing.
 *
 * On success, returns the created reqDoc.
 * On enqueue failure:
 *   - marks reqDoc.status = 'failed' (best-effort)
 *   - re-throws the enqueue error so the caller can handle it (e.g. return 503)
 *
 * @param {{ userId?, institutionId?, cohortId?, assessmentId?,
 *           requestedByInstitutionUserId?, roleTrack, difficulty, language,
 *           jobDescription, topicHint }} params
 * @param {object} deps  - injectable: { CapstoneGenerationRequest, capstoneGenerationWorker }
 * @returns {Promise<object>} reqDoc
 */
async function requestGeneration(
  {
    userId,
    institutionId,
    cohortId,
    assessmentId,
    requestedByInstitutionUserId,
    roleTrack,
    difficulty,
    language,
    jobDescription,
    topicHint,
  },
  deps = {}
) {
  const CapstoneGenerationRequest =
    deps.CapstoneGenerationRequest ||
    require('../models/capstoneGenerationRequest.model');
  const capstoneGenerationWorker =
    deps.capstoneGenerationWorker ||
    require('../workers/capstoneGeneration.worker');

  const ownership = institutionId
    ? {
        institution_id: institutionId,
        cohort_id: cohortId || undefined,
        assessment_id: assessmentId || undefined,
        requested_by_institution_user: requestedByInstitutionUserId || undefined,
      }
    : { user_id: userId };

  const reqDoc = await CapstoneGenerationRequest.create({
    ...ownership,
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
