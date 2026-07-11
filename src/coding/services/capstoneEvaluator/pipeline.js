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
const gradeJudge = require('../../../services/grading/gradeJudgeService');

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

  // 1. Pull final files — live sandbox first, then most recent S3 snapshot.
  const snapshotKey =
    recording?.snapshots?.length > 0
      ? recording.snapshots[recording.snapshots.length - 1].s3_key
      : null;
  const finalFiles = await finalHarness
    .pullFinalFiles({
      sandboxId: session.sandbox_id,
      snapshotS3Key: snapshotKey,
    })
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
  // Deterministic test split behind the correctness score — surfaced to the
  // learner so "I did well but scored low" is self-explanatory.
  const test_summary = {
    visible_passed: harness.visible.filter((t) => t.passed).length,
    visible_total: harness.visible.length,
    hidden_passed: harness.hidden.filter((t) => t.passed).length,
    hidden_total: harness.hidden.length,
    lint_passed: !!harness.lint?.passed,
  };

  // ── Deterministic core (spec §Answer-side) ─────────────────────────────────
  // (a) correctness is derived from the harness pass-ratio, NOT the LLM.
  // (b) overall_score is recomputed in code from Σ dim×10×weight. The LLM's
  //     self-reported overall_score is kept ONLY as drift telemetry.
  const dimension_scores = { ...scored.dimension_scores };
  const derivedCorrectness = scorer.deriveCorrectnessFromHarness(harness);
  if (derivedCorrectness != null) dimension_scores.correctness = derivedCorrectness;
  const codeOverall = scorer.computeOverallScore(dimension_scores, scorer.RUBRIC_WEIGHTS);
  const llmOverall = Math.round(Number(scored.overall_score) || 0);
  const scoreDrift = Math.abs(codeOverall - llmOverall);
  if (scoreDrift > 10) {
    // eslint-disable-next-line no-console
    console.warn(
      `[capstoneEvaluator] score drift for session=${sessionId}: code=${codeOverall} llm=${llmOverall} (Δ${scoreDrift})`
    );
  }

  const result = {
    overall_score: codeOverall,
    llm_overall_score: llmOverall,
    score_drift: scoreDrift,
    dimension_scores,
    dimension_feedback: scored.dimension_feedback || null,
    overall_rationale: typeof scored.overall_rationale === 'string' ? scored.overall_rationale : '',
    test_summary,
    rubric_weights: scorer.RUBRIC_WEIGHTS,
    strengths: Array.isArray(scored.strengths) ? scored.strengths.slice(0, 5) : [],
    gaps: Array.isArray(scored.gaps) ? scored.gaps.slice(0, 5) : [],
    interview_parallel: scored.interview_parallel,
    integrity_confidence: scored.integrity_confidence,
    anchor_drift_detected: drift.driftDetected,
    evaluator_model: scored.evaluator_model,
    needs_review: false,
    graded_at: new Date(),
    evidence_notes: typeof scored.evidence_notes === 'string' ? scored.evidence_notes : '',
  };

  // ── Answer-side LLM-as-judge (best-effort; never bricks a grade) ────────────
  // An independent (cross-family) judge audits the overall against the evidence.
  // On >15-pt disagreement we auto re-grade once (strict re-score → recompute);
  // still divergent ⇒ needs_review. Coverage knob: GRADE_JUDGE_SAMPLE_RATE.
  try {
    const evidence = [
      `Diff: files_changed=${diff.files_changed} +${diff.lines_added}/-${diff.lines_removed}`,
      `Tests: visible ${test_summary.visible_passed}/${test_summary.visible_total}, hidden ${test_summary.hidden_passed}/${test_summary.hidden_total}, lint ${test_summary.lint_passed ? 'clean' : 'issues'}`,
      `Rationale: ${result.overall_rationale || '(none)'}`,
    ].join('\n');
    const capstoneRegrade = async () => {
      const s = await scorer.score({
        bundle, diff, harness, compassLog: compass,
        voiceTranscript: session.voice_reflection_transcript || null,
        mode: 'strict', rubricAnchors: bundle.rubric_anchors || [], actor,
      });
      const ds = { ...s.dimension_scores };
      const dc = scorer.deriveCorrectnessFromHarness(harness);
      if (dc != null) ds.correctness = dc;
      return { overall: scorer.computeOverallScore(ds, scorer.RUBRIC_WEIGHTS) };
    };
    const verdict = await gradeJudge.reconcile({
      engine: 'capstone',
      evidence,
      rubric: scorer.RUBRIC_WEIGHTS,
      graderResult: { overall: codeOverall, dimensions: dimension_scores },
      regrade: capstoneRegrade,
    });
    if (verdict.sampled) {
      if (typeof verdict.finalOverall === 'number') result.overall_score = Math.round(verdict.finalOverall);
      result.needs_review = !!verdict.needsReview;
      result.judge_overall = verdict.judgeOverall;
      result.judge_disagreement = verdict.disagreement;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[capstoneEvaluator] grade judge failed for session=${sessionId}: ${err.message}`);
  }

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

/**
 * Re-score a graded session with the voice-reflection transcript now in
 * scope. Used by the voice-reflection worker (WS8). Bypasses the state
 * machine because we don't want to expose graded → evaluating → graded
 * to other code paths.
 *
 * Skips the harness re-run (sandbox is gone post-submit). Re-derives the
 * cheap inputs (diff against empty filetree just for shape; compass log
 * from S3) so the scorer has a complete context envelope; the meaningful
 * delta is the voice transcript.
 */
async function _rescoreReflectionOnly(sessionId) {
  const session = await CapstoneSession.findById(sessionId).lean();
  if (!session || session.status !== 'graded') return;
  if (!session.voice_reflection_transcript) return;

  const bundle = await ArtifactBundle.findById(session.bundle_id).lean();
  if (!bundle) return;

  const recording = await CapstoneRecording.findOne({ session_id: sessionId }).lean();

  // Harness is skipped — the sandbox is gone post-submit. We pass an
  // empty harness payload (the scorer interprets this as "rely on the
  // existing dimension scores below for correctness / code_quality /
  // verification" via the strengths-preservation merge that follows).
  const harnessSummary = {
    visible: [],
    hidden: [],
    lint: { passed: true, output: '(harness skipped on rescore)', durationMs: 0 },
    provisionMs: 0,
    teardownMs: 0,
  };
  const diff = diffLib.diffTrees(bundle.starter_repo || { files: [] }, { files: [] });
  const compass = await compassLog.analyse(recording?.event_stream_s3_key);

  const scored = await scorer.score({
    bundle,
    diff,
    harness: harnessSummary,
    compassLog: compass,
    voiceTranscript: session.voice_reflection_transcript,
    mode: 'normal',
    rubricAnchors: bundle.rubric_anchors || [],
    actor: { userId: session.user_id, sessionId: session._id, bundleId: bundle._id },
  });

  // Merge: preserve the original non-reflection dimension scores
  // (harness was skipped this run so those numbers aren't reliable);
  // overwrite reflection_quality + recompute overall_score per spec §8.2.
  const oldDims = session.result?.dimension_scores || {};
  const newDims = {
    correctness: oldDims.correctness ?? 0,
    code_quality: oldDims.code_quality ?? 0,
    ai_pair_effectiveness: oldDims.ai_pair_effectiveness ?? 0,
    verification_discipline: oldDims.verification_discipline ?? 0,
    decomposition: oldDims.decomposition ?? 0,
    reflection_quality: scored.dimension_scores.reflection_quality,
  };
  const weights = scorer.RUBRIC_WEIGHTS;
  const overall = Math.round(
    Object.entries(weights).reduce((s, [k, w]) => s + (newDims[k] || 0) * 10 * w, 0)
  );

  // Preserve the original per-dimension feedback (the harness was skipped this
  // run, so only reflection_quality's narrative is reliable from this rescore);
  // overwrite reflection_quality's feedback and refresh the overall rationale.
  const mergedFeedback = {
    ...(session.result?.dimension_feedback || {}),
    reflection_quality:
      scored.dimension_feedback?.reflection_quality ||
      session.result?.dimension_feedback?.reflection_quality ||
      null,
  };

  await CapstoneSession.findByIdAndUpdate(sessionId, {
    $set: {
      'result.dimension_scores': newDims,
      'result.overall_score': overall,
      'result.dimension_feedback': mergedFeedback,
      'result.overall_rationale':
        scored.overall_rationale || session.result?.overall_rationale || '',
      'result.strengths': scored.strengths?.slice(0, 5) || session.result?.strengths || [],
      'result.gaps': scored.gaps?.slice(0, 5) || session.result?.gaps || [],
      'result.graded_at': new Date(),
    },
  });
}

module.exports = { evaluate, _rescoreReflectionOnly };
