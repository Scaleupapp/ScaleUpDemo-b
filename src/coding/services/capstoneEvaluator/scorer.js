'use strict';

const { llmCall } = require('../llmRouter');
const { parseLLMJson } = require('../drillGrader/parseLLMJson');
const costTracker = require('../costTracker');

/**
 * Six-dimension Sonnet scorer (spec §8.2).
 *
 * One Sonnet 4.6 call per session per pass. Inputs: diff + harness results
 * + Compass log analysis + bundle context. Output: structured scores +
 * strengths + gaps + interview parallel + integrity_confidence.
 *
 * Strictness modes:
 *   - 'normal' — standard prompt
 *   - 'strict' — anchor-drift re-run; tells the model the previous output
 *     disagreed with deterministic anchors and asks it to align with them
 *
 * The prompt asks for a JSON envelope. We strip ```json fences via
 * parseLLMJson (same helper Phase A's drill graders use). On unparseable
 * output we throw — the worker treats that as a transient failure
 * (retry up to maxAttempts).
 */

const SYSTEM_NORMAL = `You are an expert engineering evaluator. You grade Capstone sessions on six dimensions and produce structured feedback. Be honest, not generous. Anchor your scores in observable evidence (tests passed, code quality, prompt quality, verification behavior, decomposition cadence, voice reflection).

Score 0-10 on each dimension; weights are:
- correctness (25%)              — proportion of visible + hidden tests passing, acceptance harness met
- code_quality (15%)              — readability, modularity, dead code, error handling, type-safety
- ai_pair_effectiveness (20%)    — prompt quality, accept/edit/reject ratio, rework cycles
- verification_discipline (15%) — tests run, seeded mistakes caught, test-write cadence
- decomposition (10%)             — commit cadence, file-order traversal, Compass turn structure
- reflection_quality (15%)       — when voice reflection transcript is provided; otherwise score 5

Combine to overall_score on a 0–100 scale using the weights above.

Anti-cheat signals:
- High paste_count relative to turn_count + accept_ratio near 1.0 → low integrity_confidence
- tab_blur_count high → lower integrity_confidence
- Diff massively larger than reference solution + no commit cadence → low integrity_confidence
- Voice reflection inconsistent with diff narrative → low integrity_confidence

Return STRICT JSON only (no prose, no markdown fences):
{
  "dimension_scores": {
    "correctness": <0-10>,
    "code_quality": <0-10>,
    "ai_pair_effectiveness": <0-10>,
    "verification_discipline": <0-10>,
    "decomposition": <0-10>,
    "reflection_quality": <0-10>
  },
  "overall_score": <0-100 integer>,
  "strengths": ["<up to 5 specific, evidence-backed phrases>"],
  "gaps": ["<up to 5 specific, actionable phrases>"],
  "interview_parallel": "<single sentence linking this to an interview round, e.g. 'Razorpay backend lateral round, payments-integration block'>",
  "integrity_confidence": "high" | "medium" | "low",
  "evidence_notes": "<2-4 sentences citing specific test names, file paths, or Compass turns that drove the scores>"
}`;

const SYSTEM_STRICT_PREAMBLE = `Your previous evaluation of this session disagreed with the bundle's deterministic rubric anchors by more than 2 points on at least one dimension. Re-evaluate, prioritising the anchor checks below over your free judgment. Match the anchor's expected score on the anchored dimensions unless the underlying observation is clearly different.

`;

/**
 * @param {object} args
 * @param {object} args.bundle
 * @param {object} args.diff                — output of diff.diffTrees
 * @param {object} args.harness             — output of finalHarness.runFinalHarness
 * @param {object} args.compassLog          — output of compassLog.analyse
 * @param {string} [args.voiceTranscript]   — present when voice reflection was uploaded
 * @param {string} [args.mode='normal']     — 'normal' | 'strict'
 * @param {Array<object>} [args.rubricAnchors] — bundle.rubric_anchors
 * @param {{userId, sessionId, bundleId}} args.actor
 * @returns {Promise<{
 *   dimension_scores: object,
 *   overall_score: number,
 *   strengths: string[],
 *   gaps: string[],
 *   interview_parallel: string,
 *   integrity_confidence: string,
 *   evidence_notes: string,
 *   evaluator_model: string
 * }>}
 */
async function score({
  bundle,
  diff,
  harness,
  compassLog,
  voiceTranscript,
  mode = 'normal',
  rubricAnchors = [],
  actor = {},
} = {}) {
  const system =
    mode === 'strict'
      ? SYSTEM_STRICT_PREAMBLE + SYSTEM_NORMAL
      : SYSTEM_NORMAL;

  const userMsg = buildUserMessage({
    bundle,
    diff,
    harness,
    compassLog,
    voiceTranscript,
    rubricAnchors,
  });

  const taskId =
    mode === 'strict' ? 'capstone_evaluator_strict' : 'capstone_evaluator';

  let result;
  let outcome = 'ok';
  let errorClass;
  try {
    result = await llmCall({
      taskId: 'capstone_evaluator', // routing table key — strict shares the same model
      system,
      messages: [{ role: 'user', content: userMsg }],
    });
  } catch (err) {
    outcome = err.name === 'AbortError' ? 'timeout' : 'error';
    errorClass = err.constructor?.name || 'Error';
    await costTracker
      .recordSpend({ result: { _meta: { taskId, provider: 'anthropic' } }, taskId, actor, outcome, errorClass })
      .catch(() => {});
    throw err;
  }

  await costTracker.recordSpend({ result, taskId, actor, outcome }).catch(() => {});

  // parseLLMJson takes the raw content array (Anthropic returns blocks).
  // It strips ```json fences then JSON.parse — same helper Phase A drill
  // graders use.
  const parsed = parseLLMJson(result.content);
  validate(parsed);

  return {
    ...parsed,
    evaluator_model: result._meta?.model || 'unknown',
  };
}

function buildUserMessage({ bundle, diff, harness, compassLog, voiceTranscript, rubricAnchors }) {
  const visiblePass = harness.visible.filter((t) => t.passed).length;
  const hiddenPass = harness.hidden.filter((t) => t.passed).length;
  return [
    `# Bundle context`,
    `Role track: ${bundle.role_track}`,
    `Difficulty: ${bundle.difficulty}`,
    `Language: ${bundle.language}${bundle.stack_variant ? ` · stack ${bundle.stack_variant}` : ''}`,
    `Time budget: ${bundle.time_budget_minutes} min`,
    ``,
    `# Brief`,
    bundle.brief,
    ``,
    `# Acceptance criteria`,
    (bundle.acceptance_criteria || []).map((c) => `- ${c}`).join('\n') || '(none)',
    ``,
    `# Diff summary`,
    `files_changed=${diff.files_changed} added=${diff.files_added.length} deleted=${diff.files_deleted.length} +${diff.lines_added}/-${diff.lines_removed}`,
    ``,
    `# Unified diff (truncated to 12 KB)`,
    truncate(diff.unified_diff || '(empty)', 12_000),
    ``,
    `# Harness results`,
    `Visible tests: ${visiblePass}/${harness.visible.length} passed`,
    harness.visible.map((t) => `  - ${t.passed ? '✓' : '✗'} ${t.name} (${t.durationMs}ms)`).join('\n'),
    `Hidden tests: ${hiddenPass}/${harness.hidden.length} passed`,
    harness.hidden.map((t) => `  - ${t.passed ? '✓' : '✗'} ${t.name} (${t.durationMs}ms)`).join('\n'),
    `Lint: ${harness.lint.passed ? 'clean' : 'issues'}`,
    truncate(harness.lint.output || '', 2_000),
    ``,
    `# Compass-log analysis`,
    `turns=${compassLog.turn_count} accept=${compassLog.accept_count}(${compassLog.accept_ratio}) edit=${compassLog.edit_count}(${compassLog.edit_ratio}) reject=${compassLog.reject_count}(${compassLog.reject_ratio}) rework_cycles=${compassLog.rework_cycles} pastes=${compassLog.paste_count} tab_blurs=${compassLog.tab_blur_count}`,
    ``,
    `# Seeded mistakes (private — these are landmines we hid in starter; check if learner caught them)`,
    (bundle.seeded_mistakes || []).map((m) => `- ${m.location}: ${m.bug_description}`).join('\n') || '(none)',
    ``,
    `# Rubric anchors (deterministic — if you score these dimensions, respect the anchor scores within 2 points)`,
    (rubricAnchors || []).map((a) => `- ${a.dimension}: ${a.check} (weight ${a.weight})`).join('\n') || '(none)',
    ``,
    voiceTranscript
      ? `# Voice reflection transcript\n${truncate(voiceTranscript, 4_000)}`
      : `# Voice reflection\n(not provided — score reflection_quality at 5)`,
  ].join('\n');
}

function truncate(s, n) {
  if (!s || s.length <= n) return s || '';
  return s.slice(0, n) + `\n…(truncated ${s.length - n} chars)`;
}

function validate(parsed) {
  const required = [
    'dimension_scores',
    'overall_score',
    'strengths',
    'gaps',
    'integrity_confidence',
  ];
  for (const k of required) {
    if (parsed[k] == null) throw new Error(`scorer: missing ${k} in LLM output`);
  }
  const dims = [
    'correctness',
    'code_quality',
    'ai_pair_effectiveness',
    'verification_discipline',
    'decomposition',
    'reflection_quality',
  ];
  for (const d of dims) {
    if (typeof parsed.dimension_scores[d] !== 'number') {
      throw new Error(`scorer: missing/invalid dimension_scores.${d}`);
    }
  }
  if (!['high', 'medium', 'low'].includes(parsed.integrity_confidence)) {
    throw new Error(`scorer: invalid integrity_confidence "${parsed.integrity_confidence}"`);
  }
  if (typeof parsed.overall_score !== 'number' || parsed.overall_score < 0 || parsed.overall_score > 100) {
    throw new Error(`scorer: overall_score out of range`);
  }
}

module.exports = { score, SYSTEM_NORMAL };
