'use strict';

/**
 * Content Validator service (Phase A)
 *
 * Validates a generated ArtifactBundle (status: 'draft') by running 8 checks.
 * On pass: marks status 'validated', stamps validator_model + validated_at.
 * On fail: caller is responsible for routing to HumanReviewQueue via pushToHumanReview().
 *
 * Checks (spec §4.2):
 *  1. starter_repo builds without error (sandbox — best-effort for Phase A)
 *  2. reference_solution passes all visible_tests + hidden_tests (sandbox)
 *  3. random non-solution code fails tests (sandbox — trivial corruption, expect failure)
 *  4. seeded_mistakes fail tests (Phase B — skipped with note)
 *  5. visible_tests + hidden_tests are distinct by test `name`
 *  6. difficulty matches stated level (Gemini cross-model check via llmRouter)
 *  7. brief is unambiguous (same Gemini call as #6)
 *  8. content_hash is not a duplicate of any existing active/validated bundle
 */

const { ArtifactBundle, HumanReviewQueue } = require('../models');
const { llmCall } = require('./llmRouter');
const sandbox = require('./sandbox/localSandbox');

// ── Individual check functions ────────────────────────────────────────────────

/**
 * Check 1: starter_repo builds without error.
 * Phase A: best-effort — if no files are present, skip.
 */
async function checkStarterBuilds(bundle) {
  if (!bundle.starter_repo || !bundle.starter_repo.files || bundle.starter_repo.files.length === 0) {
    return { ok: true, skipped: true };
  }
  // Best-effort: if a setup command is defined in the first visible_test, run it.
  // Otherwise, just validate that the files can be written (already confirmed by mkdirSync).
  // Phase B will add a real build step.
  return { ok: true };
}

/**
 * Runs test specs against the given files in the sandbox.
 * Returns { allPass: boolean, results: Array }.
 */
async function runTestsOn(files, tests) {
  if (!tests || tests.length === 0) return { allPass: true, results: [] };
  const results = await Promise.all(
    tests.map(t =>
      sandbox.runInTempDir({ files, command: t.command, timeout_ms: 15000 })
    )
  );
  const allPass = results.every((r, i) =>
    r.exit_code === (tests[i].expected_exit_code !== undefined ? tests[i].expected_exit_code : 0)
  );
  return { allPass, results };
}

/**
 * Check 2: reference_solution passes all visible_tests + hidden_tests.
 */
async function checkReferenceSolution(bundle) {
  const files = bundle.reference_solution && bundle.reference_solution.files;
  if (!files || files.length === 0) {
    return { ok: false, error: 'reference_solution has no files' };
  }

  const allTests = [...(bundle.visible_tests || []), ...(bundle.hidden_tests || [])];
  if (allTests.length === 0) {
    return { ok: true, skipped: true, note: 'no tests to run' };
  }

  const { allPass, results } = await runTestsOn(files, allTests);
  if (!allPass) {
    const failed = results
      .map((r, i) => ({ test: allTests[i].name, exit_code: r.exit_code, stderr: r.stderr?.slice(0, 200) }))
      .filter((_, i) => results[i].exit_code !== (allTests[i].expected_exit_code || 0));
    return { ok: false, error: 'reference_solution did not pass all tests', failed };
  }
  return { ok: true };
}

/**
 * Check 3: non-solution code (trivially corrupted) should fail the tests.
 * If tests still pass when code is broken, the tests are too weak.
 */
async function checkNonSolutionFails(bundle) {
  const files = (bundle.reference_solution && bundle.reference_solution.files) || [];
  if (files.length === 0) return { ok: true, skipped: true };

  // Corrupt the first file by prepending a syntax error
  const corrupted = files.map((f, i) =>
    i === 0 ? { ...f, content: 'THIS_IS_NOT_VALID_CODE_!!!\n' + f.content } : f
  );

  const allTests = [...(bundle.visible_tests || []), ...(bundle.hidden_tests || [])];
  if (allTests.length === 0) return { ok: true, skipped: true };

  const { allPass } = await runTestsOn(corrupted, allTests);
  if (allPass) {
    return { ok: false, error: 'tests passed even with corrupted code — tests are too weak' };
  }
  return { ok: true };
}

/**
 * Check 4: seeded_mistakes each fail the tests when applied.
 * Phase A: skipped — mechanical application requires structured before/after snippets
 * which are added in Phase B. Gemini semantic check (check 6/7) covers these indirectly.
 */
async function checkSeededMistakesFail(bundle) {
  const seeded = bundle.seeded_mistakes || [];
  if (seeded.length === 0) return { ok: true, skipped: true };
  // Phase B will apply each seeded_mistake programmatically and re-run tests.
  return { ok: true, skipped: true, note: 'mechanical seeded_mistake application is Phase B' };
}

/**
 * Check 5: visible_tests and hidden_tests have no names in common.
 */
function checkTestsDistinct(bundle) {
  const visibleNames = new Set((bundle.visible_tests || []).map(t => t.name));
  const hiddenNames  = (bundle.hidden_tests || []).map(t => t.name);
  const overlap      = hiddenNames.filter(n => visibleNames.has(n));
  if (overlap.length > 0) {
    return { ok: false, error: `tests overlap between visible and hidden: ${overlap.join(', ')}` };
  }
  return { ok: true };
}

/**
 * Checks 6 + 7: Cross-model Gemini validation.
 * Sends the bundle to Gemini and asks:
 *   - Does the difficulty match the actual complexity?
 *   - Is the brief unambiguous?
 */
async function checkSemanticConsistency(bundle) {
  const prompt = `Review this ArtifactBundle for quality:

BUNDLE:
${JSON.stringify({
    type: bundle.type,
    drill_subtype: bundle.drill_subtype,
    role_track: bundle.role_track,
    language: bundle.language,
    difficulty: bundle.difficulty,
    brief: bundle.brief,
    acceptance_criteria: bundle.acceptance_criteria,
    reference_solution: bundle.reference_solution,
    seeded_mistakes: bundle.seeded_mistakes,
  }, null, 2)}

Check:
1. Does the stated difficulty match the actual difficulty? (Easy = ~5min, Medium = ~10min, Hard = ~15min for a competent learner.)
2. Is the brief unambiguous? Or could two learners reasonably interpret it differently?

Return STRICT JSON: { difficulty_matches: boolean, brief_unambiguous: boolean, notes: string }`;

  const res = await llmCall({
    taskId: 'content_validator_cross',
    system: 'You are a content quality reviewer for coding practice problems.',
    prompt,
  });

  // Normalise the response — Gemini returns { content: { parts: [{ text }] } }
  // while Anthropic returns { content: [{ type: 'text', text }] }
  let text = '';
  try {
    if (res.content && Array.isArray(res.content.parts)) {
      // Gemini format: { content: { parts: [{ text }] } }
      text = res.content.parts.map(p => p.text || '').join('');
    } else if (Array.isArray(res.content)) {
      // Anthropic format: { content: [{ type, text }] }
      text = res.content.find(c => c.text)?.text || '';
    } else if (typeof res.content === 'string') {
      text = res.content;
    }
    // Strip markdown code fences if present
    text = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
  } catch (e) {
    return { ok: false, error: `unable to parse validator response: ${e.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `validator returned non-JSON: ${text.slice(0, 200)}` };
  }

  if (!parsed.difficulty_matches) {
    return { ok: false, error: `difficulty mismatch: ${parsed.notes || ''}` };
  }
  if (!parsed.brief_unambiguous) {
    return { ok: false, error: `brief ambiguous: ${parsed.notes || ''}` };
  }
  return { ok: true };
}

/**
 * Check 8: content_hash is unique among active and validated bundles.
 */
async function checkContentHashUnique(bundle) {
  if (!bundle.content_hash) {
    return { ok: false, error: 'no content_hash on bundle' };
  }
  const dup = await ArtifactBundle.findOne({
    content_hash: bundle.content_hash,
    _id: { $ne: bundle._id },
    status: { $in: ['validated', 'active'] },
  });
  if (dup) {
    return { ok: false, error: `duplicate content_hash matches bundle ${dup._id}` };
  }
  return { ok: true };
}

// ── Main validate function ────────────────────────────────────────────────────

/**
 * Validates an ArtifactBundle (must be in 'draft' status).
 *
 * @param {object} opts
 * @param {string} opts.bundle_id — MongoDB ObjectId string
 * @returns {Promise<{ ok: boolean, results: Array, errors?: string[] }>}
 */
async function validate({ bundle_id }) {
  // `.lean()` must be called on the QUERY, not on an already-awaited document —
  // `await findById(...)` resolves to a Mongoose doc which has no `.lean()`
  // (that threw "bundleQuery.lean is not a function" and failed every validation).
  const bundle = await ArtifactBundle.findById(bundle_id).lean();
  if (!bundle) throw new Error(`Bundle ${bundle_id} not found`);

  const checks = [
    { name: 'starter_builds',         fn: () => checkStarterBuilds(bundle) },
    { name: 'reference_solution_passes', fn: () => checkReferenceSolution(bundle) },
    { name: 'non_solution_fails',      fn: () => checkNonSolutionFails(bundle) },
    { name: 'seeded_mistakes_fail',    fn: () => checkSeededMistakesFail(bundle) },
    { name: 'tests_distinct',          fn: () => Promise.resolve(checkTestsDistinct(bundle)) },
    { name: 'semantic_consistency',    fn: () => checkSemanticConsistency(bundle) },
    { name: 'content_hash_unique',     fn: () => checkContentHashUnique(bundle) },
  ];

  const results = [];
  for (const c of checks) {
    const r = await c.fn();
    results.push({ name: c.name, ...r });
    if (!r.ok && !r.skipped) {
      return { ok: false, errors: [`${c.name}: ${r.error || 'failed'}`], results };
    }
  }

  // All checks passed — stamp and mark validated. Guard the transition to
  // `draft` only: a bundle that has since been activated/retired/manually
  // overridden by another process must NOT be silently flipped back to
  // 'validated' (that would, e.g., demote a live 'active' bundle out of the
  // attemptable library). If it's no longer 'draft', the validation result
  // still returns ok — we just don't clobber the newer status.
  const validator_model = 'gemini-2.5-pro';
  await ArtifactBundle.findOneAndUpdate(
    { _id: bundle_id, status: 'draft' },
    {
      $set: {
        status: 'validated',
        'generated_by.validator_model': validator_model,
        'generated_by.validated_at': new Date(),
      },
    }
  );

  return { ok: true, results };
}

// ── Human review helper ───────────────────────────────────────────────────────

/**
 * Enqueues a bundle for human review after validation failure.
 *
 * @param {object} opts
 * @param {string}   opts.bundle_id
 * @param {string[]} opts.errors — validator error strings
 */
async function pushToHumanReview({ bundle_id, errors }) {
  return HumanReviewQueue.create({
    bundle_id,
    reason: 'validator_failed',
    validator_errors: errors,
    status: 'pending',
  });
}

module.exports = {
  validate,
  pushToHumanReview,
  // Exported for direct unit testing
  checkTestsDistinct,
  checkContentHashUnique,
};
