'use strict';

const CapstoneSession = require('../../models/capstoneSession.model');
const CapstoneRecording = require('../../models/capstoneRecording.model');
const ArtifactBundle = require('../../models/artifactBundle.model');
const stateMachine = require('../sessionStateMachine');
const sessionRoom = require('../../websocket/sessionRoom');
const notificationService = require('../../../services/notificationService');

const diffLib = require('./diff');
const finalHarness = require('./finalHarness');
const compassLog = require('./compassLog');
const scorer = require('./scorer');
const anchorDrift = require('./anchorDrift');

/**
 * Capstone evaluator pipeline — the function the BullMQ worker calls.
 *
 * Flow (spec §7.2 step 10 + §8.2 + §8.3):
 *   1. Load session + bundle + recording
 *   2. Pull final files (live sandbox if alive; else last snapshot)
 *   3. Run final harness (visible + hidden tests + lint) in a clean sandbox
 *   4. Diff starter → final
 *   5. Analyse Compass log (AI-pair-effectiveness signal + integrity)
 *   6. Score (one Sonnet call): six dimensions + strengths/gaps + integrity
 *   7. Anchor-drift check:
 *        - if drifted: file HRQ entry + re-run scorer in strict mode
 *        - if still drifted after strict: keep strict score, leave HRQ open
 *   8. Persist result, transition session → graded, broadcast lifecycle,
 *      fire push notification.
 *
 * The whole thing is wrapped in a try/finally that flips state back to
 * `submitted` on hard failure so the worker can retry from a known state.
 * The BullMQ job retry policy backs off exponentially (configured in
 * the worker file).
 */

/**
 * @param {object} args
 * @param {string} args.sessionId
 * @returns {Promise<{ overall_score: number, integrity_confidence: string, anchor_drift_detected: boolean }>}
 */
async function evaluate({ sessionId }) {
  if (!sessionId) throw new Error('pipeline.evaluate: sessionId required');

  const session = await CapstoneSession.findById(sessionId);
  if (!session) throw new Error(`CapstoneSession ${sessionId} not found`);

  // Only evaluate submitted / evaluating sessions. graded → no-op (idempotent
  // for retries that won the race).
  if (session.status === 'graded') {
    return {
      overall_score: session.result?.overall_score ?? 0,
      integrity_confidence: session.result?.integrity_confidence ?? 'medium',
      anchor_drift_detected: session.result?.anchor_drift_detected ?? false,
    };
  }
  if (!['submitted', 'evaluating'].includes(session.status)) {
    throw new Error(`Session ${sessionId} in non-evaluable status: ${session.status}`);
  }

  // Move to evaluating + broadcast.
  if (session.status === 'submitted') {
    const after = await stateMachine.transition(sessionId, 'evaluating');
    sessionRoom.publishLifecycle(sessionId, after.status);
  }

  const bundle = await ArtifactBundle.findById(session.bundle_id).lean();
  if (!bundle) throw new Error(`ArtifactBundle ${session.bundle_id} not found`);

  const recording = await CapstoneRecording.findOne({ session_id: sessionId }).lean();
  // Recording can legitimately be missing if a fork-bomb-style crash reaped
  // the sandbox before any flush. Score on diff alone in that case.

  // 1. Pull final files
  const snapshotKey =
    recording?.snapshots?.length > 0 ? recording.snapshots[recording.snapshots.length - 1].s3_key : null;
  // Snapshot resolution (S3 → filetree) lands in WS8.1; for now we only
  // have the live-sandbox path. If the sandbox is dead and there's no
  // snapshot, we score against an empty final filetree which forces the
  // correctness dimension to 0 — the right behavior.
  const finalFiles = await finalHarness
    .pullFinalFiles({ sandboxId: session.sandbox_id, snapshotFiles: snapshotKey ? null : null })
    .catch(() => null);

  // 2. Run final harness (clean sandbox, visible + hidden tests + lint)
  const harness = await finalHarness.runFinalHarness({
    bundle,
    finalFiles: finalFiles || [],
    visibleTests: bundle.visible_tests || [],
    hiddenTests: bundle.hidden_tests || [],
  });

  // 3. Diff
  const diff = diffLib.diffTrees(bundle.starter_repo || { files: [] }, { files: finalFiles || [] });

  // 4. Compass log analysis
  const compass = await compassLog.analyse(recording?.event_stream_s3_key);

  // 5. Score
  const actor = {
    userId: session.user_id,
    sessionId: session._id,
    bundleId: bundle._id,
  };
  let scored = await scorer.score({
    bundle,
    diff,
    harness,
    compassLog: compass,
    voiceTranscript: session.voice_reflection_transcript || null,
    mode: 'normal',
    rubricAnchors: bundle.rubric_anchors || [],
    actor,
  });

  // 6. Anchor-drift check
  const drift = await anchorDrift.check({
    bundleId: bundle._id,
    rubricAnchors: bundle.rubric_anchors || [],
    dimensionScores: scored.dimension_scores,
    evaluatorModel: scored.evaluator_model,
  });

  if (drift.driftDetected) {
    await anchorDrift.queueHumanReview({
      bundleId: bundle._id,
      sessionId: session._id,
      driftedDimensions: drift.driftedDimensions,
      evaluatorResult: scored,
    });

    // 7. Strict re-run
    const strict = await scorer.score({
      bundle,
      diff,
      harness,
      compassLog: compass,
      voiceTranscript: session.voice_reflection_transcript || null,
      mode: 'strict',
      rubricAnchors: bundle.rubric_anchors || [],
      actor,
    });
    scored = strict;
  }

  // 8. Persist result + transition + notify
  const result = {
    overall_score: Math.round(scored.overall_score),
    dimension_scores: scored.dimension_scores,
    strengths: Array.isArray(scored.strengths) ? scored.strengths.slice(0, 5) : [],
    gaps: Array.isArray(scored.gaps) ? scored.gaps.slice(0, 5) : [],
    interview_parallel: scored.interview_parallel,
    integrity_confidence: scored.integrity_confidence,
    anchor_drift_detected: drift.driftDetected,
    evaluator_model: scored.evaluator_model,
    graded_at: new Date(),
  };

  await CapstoneSession.findByIdAndUpdate(sessionId, { $set: { result } });
  const graded = await stateMachine.transition(sessionId, 'graded');
  sessionRoom.publishLifecycle(sessionId, graded.status);

  // Push notification (best-effort, never throws — notification failure
  // should never gate a successful grade).
  try {
    await notificationService.sendToUser(session.user_id, {
      title: 'Your capstone is graded',
      body: `Overall score: ${result.overall_score}/100`,
      data: { type: 'capstone_graded', session_id: String(sessionId) },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[capstoneEvaluator] push failed:', err.message);
  }

  return {
    overall_score: result.overall_score,
    integrity_confidence: result.integrity_confidence,
    anchor_drift_detected: result.anchor_drift_detected,
  };
}

module.exports = { evaluate };
