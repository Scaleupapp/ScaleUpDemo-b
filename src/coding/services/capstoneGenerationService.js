'use strict';

/**
 * capstoneGenerationService — orchestrates on-demand, learner-initiated
 * capstone generation with a hard "it provably works" gate.
 *
 * The proof bar (founder requirement: "make sure there is no errors and
 * everything works perfectly fine"):
 *   1. GENERATE  — Claude Opus drafts a full capstone bundle (brief, starter
 *                  repo, visible + hidden tests, reference solution, seeded
 *                  mistakes, rubric anchors).
 *   2. VALIDATE  — generationPipeline.runPipeline runs the deterministic gate
 *                  IN A SANDBOX: the reference solution must pass ALL visible
 *                  + hidden tests (checkReferenceSolution), and a corrupted
 *                  solution must FAIL them (checkNonSolutionFails) — proving
 *                  the tests actually test something. Plus hash-uniqueness +
 *                  distinct-test-names. Retries up to N with critique.
 *   3. CROSS-CHECK — a DIFFERENT model (Gemini, via capstone_quality_cross)
 *                  adversarially reviews the *validated* bundle for solvability
 *                  within the time budget, brief↔tests coherence, fairness of
 *                  hidden tests, and acceptance-criteria coverage. Two distinct
 *                  model families must agree before a learner ever sees it.
 *   4. ACTIVATE  — only if 2 AND 3 pass does the bundle flip to status='active'
 *                  (attemptable). Otherwise it stays draft and the request is
 *                  marked failed with the reason.
 *
 * Status is tracked on a CapstoneGenerationRequest doc so the client polls
 * rather than holding an HTTP connection for 1-3 minutes.
 */

const CapstoneGenerationRequest = require('../models/capstoneGenerationRequest.model');
const ArtifactBundle = require('../models/artifactBundle.model');
const generationPipeline = require('./generationPipeline');
const { llmCall } = require('./llmRouter');

const DEFAULT_TIME_BUDGET = { easy: 60, medium: 75, hard: 90 };

/**
 * Entry point run by the worker. Drives one request through the full lifecycle,
 * updating the request doc at each phase. Never throws — terminal failures are
 * recorded on the request as status='failed'.
 *
 * @param {string} requestId
 */
async function runGeneration(requestId) {
  const reqDoc = await CapstoneGenerationRequest.findById(requestId);
  if (!reqDoc) return;

  try {
    await setStatus(reqDoc, 'generating');

    // Outer loop: generate+validate, then cross-check. If the independent
    // reviewer rejects on quality (ambiguous brief, weak coverage, etc.), feed
    // its feedback back into a fresh generation so the model can FIX it — the
    // same converge-on-critique idea the sandbox validation already uses, but
    // for the human-judgment gate. Without this, a single quality nitpick fails
    // the whole request and the learner just sees "Couldn't build that one".
    const MAX_CROSS_ROUNDS = 2;
    let crossFeedback = null;
    let totalAttempts = 0;
    let lastCrossNotes = null;

    for (let round = 1; round <= MAX_CROSS_ROUNDS; round += 1) {
      // 1 + 2: generate + deterministic sandbox validation (with retry/critique).
      const pipelineResult = await generationPipeline.runPipeline(
        {
          type: 'capstone',
          role_track: reqDoc.role_track,
          difficulty: reqDoc.difficulty,
          language: reqDoc.language,
          time_budget_minutes: DEFAULT_TIME_BUDGET[reqDoc.difficulty] || 75,
          topic_hint: buildTopicHint(reqDoc) + (crossFeedback
            ? `\n\nIMPORTANT: a previous version was REJECTED by an independent quality reviewer for these blocking issues: ${crossFeedback}\nProduce a NEW capstone that fixes them — make the brief fully unambiguous (define behavior for every edge case it mentions), ensure the visible + hidden tests cover every acceptance criterion, and keep it solvable within the time budget.`
            : ''),
        },
        { maxRetries: 2 }
      );

      totalAttempts += pipelineResult.attempts || 0;
      reqDoc.attempts = totalAttempts;
      if (pipelineResult.bundle_id) reqDoc.bundle_id = pipelineResult.bundle_id;

      if (!pipelineResult.ok) {
        // runPipeline already routed it to the human-review queue.
        await fail(reqDoc, `validation failed after ${pipelineResult.attempts} attempts: ${(pipelineResult.errors || []).join('; ')}`);
        return;
      }

      await setStatus(reqDoc, 'cross_checking');

      // 3: distinct-model adversarial review of the validated bundle.
      const bundle = await ArtifactBundle.findById(pipelineResult.bundle_id).lean();
      if (!bundle) {
        await fail(reqDoc, 'bundle disappeared after validation');
        return;
      }
      const cross = await crossCheckCapstone(bundle);
      reqDoc.cross_check_notes = cross.notes || null;
      lastCrossNotes = cross.notes;

      if (cross.pass) {
        // 4: activate — both the sandbox proof AND the cross-model review passed.
        await ArtifactBundle.findByIdAndUpdate(pipelineResult.bundle_id, {
          $set: {
            status: 'active',
            'generated_by.validator_model': 'gemini-2.5-pro',
            'generated_by.validated_at': new Date(),
            'generated_by.human_reviewed': false,
          },
        });
        await setStatus(reqDoc, 'ready');
        return;
      }

      // Rejected on quality — leave the draft inactive, capture the feedback,
      // and (if rounds remain) regenerate against it.
      crossFeedback = cross.notes;
      if (round < MAX_CROSS_ROUNDS) await setStatus(reqDoc, 'generating');
    }

    await fail(reqDoc, `cross-check rejected after ${MAX_CROSS_ROUNDS} rounds: ${lastCrossNotes || 'no detail'}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[capstoneGeneration] request ${requestId} crashed:`, err);
    await fail(reqDoc, `internal error: ${err.message}`).catch(() => {});
  }
}

/**
 * Distinct-model adversarial review. Returns { pass, notes }. Conservative:
 * any parse failure or explicit rejection → pass=false (we'd rather make the
 * learner regenerate than ship a broken capstone).
 */
async function crossCheckCapstone(bundle) {
  const prompt = `You are an independent senior reviewer doing a FINAL gate on an auto-generated coding capstone before a learner is allowed to attempt it. The reference solution has ALREADY been proven to pass all tests in a sandbox; your job is the human-judgment layer the sandbox can't do.

CAPSTONE:
${JSON.stringify({
    role_track: bundle.role_track,
    language: bundle.language,
    difficulty: bundle.difficulty,
    time_budget_minutes: bundle.time_budget_minutes,
    brief: bundle.brief,
    acceptance_criteria: bundle.acceptance_criteria,
    starter_repo_files: (bundle.starter_repo?.files || []).map((f) => f.path),
    visible_tests: (bundle.visible_tests || []).map((t) => t.name),
    hidden_tests: (bundle.hidden_tests || []).map((t) => t.name),
    rubric_anchors: bundle.rubric_anchors,
  }, null, 2)}

Judge strictly:
1. Is the task realistically SOLVABLE by a competent learner within ${bundle.time_budget_minutes} minutes? (Not too big, not trivially small.)
2. Is the brief UNAMBIGUOUS — would two learners build the same contract?
3. Do the visible + hidden tests actually exercise the acceptance criteria? Any criterion with no test, or any test that contradicts the brief?
4. Are the hidden tests FAIR (testing the stated spec, not gotchas the brief never mentioned)?
5. Any internal contradictions, missing setup, or impossible requirements?

Return STRICT JSON only: { "pass": boolean, "blocking_issues": string[], "notes": string }
pass=true ONLY if there are zero blocking issues. If unsure, pass=false.`;

  let res;
  try {
    res = await llmCall({
      taskId: 'capstone_quality_cross',
      system: 'You are a meticulous, skeptical reviewer of coding assessment quality. You reject anything ambiguous, unfair, or unsolvable.',
      prompt,
    });
  } catch (err) {
    return { pass: false, notes: `cross-check call failed: ${err.message}` };
  }

  const text = extractText(res);
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim());
  } catch {
    return { pass: false, notes: `cross-check returned non-JSON: ${text.slice(0, 200)}` };
  }
  const blocking = Array.isArray(parsed.blocking_issues) ? parsed.blocking_issues : [];
  if (parsed.pass === true && blocking.length === 0) {
    return { pass: true, notes: parsed.notes || 'approved' };
  }
  return { pass: false, notes: blocking.length ? blocking.join('; ') : (parsed.notes || 'rejected') };
}

function extractText(res) {
  if (!res || !res.content) return '';
  if (Array.isArray(res.content.parts)) return res.content.parts.map((p) => p.text || '').join('');
  if (Array.isArray(res.content)) return res.content.find((c) => c.text)?.text || '';
  if (typeof res.content === 'string') return res.content;
  return '';
}

function buildTopicHint(reqDoc) {
  const jd = (reqDoc.job_description || '').trim();
  const hint = (reqDoc.topic_hint || '').trim();
  if (jd && hint) return `Target role / job description:\n${jd}\n\nFocus topic: ${hint}`;
  if (jd) return `Target role / job description:\n${jd}`;
  return hint;
}

async function setStatus(reqDoc, status) {
  reqDoc.status = status;
  await reqDoc.save();
}

async function fail(reqDoc, reason) {
  reqDoc.status = 'failed';
  reqDoc.error = reason;
  await reqDoc.save();
}

module.exports = { runGeneration, crossCheckCapstone, DEFAULT_TIME_BUDGET };
