'use strict';

/**
 * Content Generator service
 *
 * Generates draft ArtifactBundles using Claude Opus 4.7 + Code Execution Tool.
 * Uses 3 nearest-neighbour seed bundles from the library as in-context examples.
 * Saves drafts to the `artifact_bundles` collection with `status: 'draft'`.
 */

const { ArtifactBundle } = require('../models');
const { llmCall } = require('./llmRouter');
const { validateBundle } = require('./bundleSchema');
const { computeContentHash } = require('./contentHash');
const alerts = require('./alerts');

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You generate ArtifactBundles for ScaleUp coding practice. Output STRICT JSON matching the schema you see in the seed examples. Use the seeds as quality + format reference, but produce a NEW problem (different brief, different code) at the same difficulty level.

Hard requirements:
- type must match what was requested
- role_track, language, difficulty, drill_subtype must match the target spec
- difficulty is a CONTRACT, not a label: honour the DIFFICULTY CONTRACT in the target spec exactly (scope, edge-case count, hidden-test rigor, failure modes, time-to-solve). A Medium/Hard problem that a junior could finish in a few minutes is WRONG output.
- reference_solution must be a complete, working solution that passes every visible_test and hidden_test (it will be executed in a sandbox to verify, so it must actually run)
- THE PROJECT MUST BE SELF-CONTAINED AND INSTALLABLE IN A CLEAN SANDBOX with only \`npm install\` / \`pip install\` (no preinstalled global tools). If a test script invokes a tool (jest, mocha, vitest, pytest, supertest, etc.), that tool MUST be declared in the dependency manifest's devDependencies/dev-requirements with a REAL, published, stable version. Never reference a binary you have not declared.
- starter_repo MUST include the dependency manifest (package.json / requirements.txt / go.mod …) AND the test files. reference_solution contains the COMPLETED source files that OVERLAY starter_repo (you need not repeat unchanged starter files); the MERGED project must \`install\` cleanly and then pass the test command.
- pin dependency versions to well-known existing releases; do not invent versions or use "latest"
- visible_tests and hidden_tests must be distinct
- seeded_mistakes (where applicable) must each be a plausible bug Compass might suggest
- seeded_mistakes[].location MUST be EXACTLY one file path from the bundle's own files (starter_repo or reference_solution) — copy the path verbatim, character for character. Do NOT append a description, a dash, a colon, a line reference, or any other text to it (e.g. "src/wallet.js" is correct; "src/wallet.js — debit balance check" or "src/wallet.js: bad check" is WRONG and will be rejected). Put the human-readable explanation of the bug in seeded_mistakes[].bug_description instead — that field is where the description belongs.
- expected_meta_skill_signals must be populated with realistic guidance

DO NOT include a content_hash, status, or generated_by — those are added by the system.

Return ONLY the JSON object, no prose, no markdown fences.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract and parse JSON from an Anthropic-style content array.
 * Handles both plain text and ```json ... ``` fenced blocks.
 *
 * @param {Array} content  — Anthropic response content array
 * @returns {object}       — Parsed JSON object
 */
function extractJson(content) {
  if (!Array.isArray(content)) throw new Error('LLM content is not an array');
  const textBlock = content.find(c => c.type === 'text' || c.text);
  if (!textBlock) throw new Error('No text block in LLM response');
  const text = (textBlock.text || '').trim();

  // 1. Happy path: the whole response is the JSON object (what we ask for).
  try { return JSON.parse(text); } catch (_) { /* fall through */ }

  // 2. A ```json fenced block specifically (NOT just any fence — the brief can
  //    itself contain ```sql / ```js code blocks that must not be mistaken for
  //    the wrapper, which is what broke "SQL window functions" generation).
  const jsonFence = text.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) {
    try { return JSON.parse(jsonFence[1].trim()); } catch (_) { /* fall through */ }
  }

  // 3. Last resort: the outermost {...} span.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return JSON.parse(text.slice(first, last + 1));
  }
  throw new Error('No JSON object found in LLM response');
}

// The six meta-skill dimensions a rubric_anchor may target.
const RUBRIC_DIMS = ['correctness', 'code_quality', 'ai_pair_effectiveness', 'verification_discipline', 'decomposition', 'reflection_quality'];

// ── Independent hidden-test generation (Wave 2 block 5) ──────────────────────
// Hidden tests authored by the SAME model that wrote the reference solution
// share its blind spots — a bug the author didn't think of won't be tested
// either. Route hidden tests through the previously-dead `hidden_test_generator`
// task (a DIFFERENT model family per the llmRouter table). Fail-open: on any
// error the draft keeps its own hidden tests — the validator still executes
// everything in the sandbox, so the hard gates are unaffected.

/** Normalise Gemini ({content:{parts}}) or Anthropic ({content:[...]}) to text. */
function contentToText(res) {
  const c = res && res.content;
  if (c && Array.isArray(c.parts)) return c.parts.map((p) => p.text || '').join('');
  if (Array.isArray(c)) return (c.find((b) => b && (b.type === 'text' || b.text)) || {}).text || '';
  if (typeof c === 'string') return c;
  return '';
}

const HIDDEN_TEST_SYSTEM =
  'You write ADVERSARIAL hidden test specs for a coding exercise you did NOT author. ' +
  'You see the brief, acceptance criteria, starter repo, visible tests, and the reference solution. ' +
  'Produce hidden tests that a plausible-but-wrong solution would fail even while passing the visible tests: ' +
  'edge cases, boundary values, error paths, subtle correctness traps. Each test must be runnable in a clean ' +
  'sandbox with the project\'s own toolchain (same test runner the visible tests use), reference only files ' +
  'that exist in the starter repo or that the test itself provides inline via the command, and must PASS ' +
  'against the reference solution. Return ONLY strict JSON: ' +
  '{"hidden_tests":[{"name":"...","command":"...","expected_exit_code":0}]}';

async function generateIndependentHiddenTests(draft, { minCount = 3 } = {}) {
  const prompt = [
    HIDDEN_TEST_SYSTEM,
    '',
    'EXERCISE:',
    JSON.stringify({
      language: draft.language,
      difficulty: draft.difficulty,
      brief: draft.brief,
      acceptance_criteria: draft.acceptance_criteria,
      starter_repo: draft.starter_repo,
      visible_tests: draft.visible_tests,
      reference_solution: draft.reference_solution,
      author_hidden_tests_count: (draft.hidden_tests || []).length,
    }),
    '',
    `Produce at least ${Math.max(minCount, (draft.hidden_tests || []).length)} hidden tests. Return only the JSON.`,
  ].join('\n');

  const res = await llmCall({ taskId: 'hidden_test_generator', prompt });
  const text = contentToText(res)
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```\s*$/g, '')
    .trim();
  const parsed = JSON.parse(text);
  const tests = Array.isArray(parsed && parsed.hidden_tests) ? parsed.hidden_tests : [];
  const cleaned = tests
    .filter((t) => t && typeof t.name === 'string' && t.name.trim() && typeof t.command === 'string' && t.command.trim())
    .map((t) => ({
      name: t.name.trim(),
      command: t.command.trim(),
      expected_exit_code: Number.isFinite(Number(t.expected_exit_code)) ? Number(t.expected_exit_code) : 0,
      ...(Array.isArray(t.expected_output_contains) ? { expected_output_contains: t.expected_output_contains } : {}),
    }));
  // De-collide with visible test names (checkTestsDistinct is a hard gate).
  const visibleNames = new Set((draft.visible_tests || []).map((t) => t.name));
  const deduped = cleaned.filter((t) => !visibleNames.has(t.name));
  if (deduped.length < minCount) {
    throw new Error(`independent hidden-test generation produced only ${deduped.length} usable tests`);
  }
  return deduped;
}

// ── Difficulty contract ─────────────────────────────────────────────────────
// Difficulty was previously a bare label with no teeth — the same quantitative
// bar was set for easy and hard, so "hard" problems came out too easy. This
// spec gives the generator MEASURABLE, per-difficulty targets (scope, edge
// cases, hidden-test rigor, failure modes, time-to-solve) so raising the
// difficulty actually raises the problem. `min_*` floors back a SOFT,
// non-blocking conformance check (we warn the operator, we do not reject).
const DIFFICULTY_ORDER = { easy: 0, medium: 1, hard: 2 };

const DIFFICULTY_SPEC = {
  easy: {
    label: 'Easy',
    scope: 'A single focused component / module with one primary code path.',
    edge_cases: 'at least 3 edge cases (empty input, a boundary value, one invalid input)',
    hidden_tests: '3 hidden tests covering the obvious edge cases',
    seeded_mistakes: '1–2 plausible bugs',
    failure_modes: 'basic input validation',
    bar: 'A junior engineer should finish comfortably inside the time budget.',
    min_edge_cases: 3,
    min_hidden_tests: 3,
  },
  medium: {
    label: 'Medium',
    scope: '2–3 interacting components/modules with more than one code path.',
    edge_cases: 'at least 6 edge cases including boundary conditions, malformed input, and at least one state-dependent or ordering case',
    hidden_tests: '4–5 hidden tests, at least one targeting a subtle correctness trap not obvious from the brief',
    seeded_mistakes: '2 plausible bugs',
    failure_modes: 'input validation + error handling + at least one non-happy-path behaviour',
    bar: 'A mid-level engineer needs most of the time budget; a junior will likely miss some hidden edge cases.',
    min_edge_cases: 6,
    min_hidden_tests: 4,
  },
  hard: {
    label: 'Hard',
    scope: '3+ interacting components, OR a single component with real algorithmic/systems depth (performance constraints, tricky invariants).',
    edge_cases: 'at least 10 edge cases including boundary, malformed, adversarial, ordering/concurrency, large-input/performance, and at least two cases a naive solution will fail',
    hidden_tests: '5+ hidden tests; SEVERAL must target failure modes that a plausible-but-wrong solution passes the VISIBLE tests yet fails — so passing the visible tests must NOT imply correctness',
    seeded_mistakes: '2–3 plausible bugs, at least one subtle',
    failure_modes: 'input validation + error handling + performance/scaling + at least two subtle correctness traps',
    bar: 'A strong engineer needs close to the full time budget; a naive solution passes the visible tests but fails multiple hidden tests.',
    min_edge_cases: 10,
    min_hidden_tests: 5,
  },
};

/** Human-readable, measurable difficulty contract injected into the prompt. */
function difficultyContractBlock(difficulty) {
  const spec = DIFFICULTY_SPEC[difficulty];
  if (!spec) return '';
  return [
    `DIFFICULTY CONTRACT — "${spec.label}" is a hard requirement, not a vibe. The problem MUST satisfy:`,
    `- Scope: ${spec.scope}`,
    `- Edge cases: ${spec.edge_cases}.`,
    `- Hidden tests: ${spec.hidden_tests}.`,
    `- Failure modes the solution must handle: ${spec.failure_modes}.`,
    `- Calibration: ${spec.bar}`,
    `- Set difficulty_signals.edge_cases to the ACTUAL number of distinct edge cases your tests exercise (must be >= ${spec.min_edge_cases} for ${spec.label}).`,
    `Do NOT produce a trivially easy problem for a Medium/Hard request — depth and adversarial hidden tests are what make it the requested difficulty.`,
  ].join('\n');
}

/**
 * SOFT, non-blocking difficulty conformance check. Returns the floors a
 * generated bundle fell short of for its stated difficulty. We surface these
 * as an operator warning (alerts.js) but never reject the bundle — product
 * decision: warn-only so generation stays fast and never "couldn't build that".
 *
 * @param {object} bundle
 * @returns {{ ok: boolean, warnings: string[] }}
 */
function checkDifficultyConformance(bundle) {
  const spec = DIFFICULTY_SPEC[bundle?.difficulty];
  if (!spec) return { ok: true, warnings: [] };
  const warnings = [];
  const edgeCases = Number(bundle?.difficulty_signals?.edge_cases ?? 0);
  if (edgeCases < spec.min_edge_cases) {
    warnings.push(`difficulty_signals.edge_cases=${edgeCases} < ${spec.min_edge_cases} expected for '${bundle.difficulty}'`);
  }
  if (bundle?.type === 'capstone') {
    const hiddenCount = Array.isArray(bundle.hidden_tests) ? bundle.hidden_tests.length : 0;
    if (hiddenCount < spec.min_hidden_tests) {
      warnings.push(`hidden_tests=${hiddenCount} < ${spec.min_hidden_tests} expected for '${bundle.difficulty}'`);
    }
  }
  return { ok: warnings.length === 0, warnings };
}

/**
 * Coerce the model's minor schema deviations so a single stray field doesn't
 * fail the whole generation. The sandbox proof (reference solution passes the
 * tests) is the real guarantee; these are cosmetic/enum slips.
 *
 * Today: rubric_anchor dimensions sometimes come back as invented,
 * domain-specific names (e.g. "query_accuracy") — coerce those to the closest
 * valid dimension ('correctness') rather than reject the bundle.
 */
function coerceRepoFiles(repo) {
  if (repo && Array.isArray(repo.files)) {
    repo.files = repo.files
      .filter((f) => f && typeof f === 'object' && typeof f.path === 'string' && f.path.trim().length > 0)
      // `content` is required by the Mongoose schema, and Mongoose's String
      // `required` rejects '' too — so an intentionally-empty stub the model
      // left contentless must become a non-empty placeholder (a newline) rather
      // than fail the whole bundle. Real content is preserved untouched; for
      // validation the reference_solution overlays these stubs anyway.
      .map((f) => ({
        ...f,
        content: (typeof f.content === 'string' && f.content.length > 0) ? f.content : '\n',
      }));
  }
}

function sanitizeDraft(draft) {
  if (!draft || typeof draft !== 'object') return draft;
  if (Array.isArray(draft.rubric_anchors)) {
    draft.rubric_anchors = draft.rubric_anchors.map((a) =>
      a && typeof a === 'object' && !RUBRIC_DIMS.includes(a.dimension)
        ? { ...a, dimension: 'correctness' }
        : a
    );
  }
  coerceRepoFiles(draft.starter_repo);
  coerceRepoFiles(draft.reference_solution);
  return draft;
}

/**
 * Retrieve up to k seed bundles that are nearest to the target spec.
 * First tries an exact match on role_track + drill_subtype + difficulty.
 * Falls back to any difficulty if fewer than k exact matches exist.
 *
 * @param {{ role_track: string, drill_subtype: string, difficulty: string }} spec
 * @param {number} [k=3]
 * @returns {Promise<object[]>}
 */
async function nearestSeeds({ type = 'drill', role_track, drill_subtype, difficulty }, k = 3) {
  // Capstones: filter by (type, role_track, difficulty). Drills: also filter
  // by drill_subtype.
  const baseFilter = {
    type,
    role_track,
    status: 'active',
    'generated_by.human_reviewed': true,
  };
  if (type === 'drill') baseFilter.drill_subtype = drill_subtype;

  const exactMatch = await ArtifactBundle.find({ ...baseFilter, difficulty })
    .limit(k)
    .lean();

  if (exactMatch.length >= k) return exactMatch;

  // Fallback: drop the difficulty constraint, but SEED HYGIENE — never anchor a
  // hard generation on easy examples. Pull a pool, then rank exact-difficulty
  // first, then harder, then easier, and take the top k. (Imitating an easier
  // seed was a contributor to "hard" problems coming out too easy.)
  const pool = await ArtifactBundle.find(baseFilter).limit(k * 4).lean();
  const target = DIFFICULTY_ORDER[difficulty] ?? 1;
  const rank = (seed) => {
    const d = (DIFFICULTY_ORDER[seed.difficulty] ?? 1) - target;
    if (d === 0) return 0; // exact difficulty — best
    if (d > 0) return d; // harder — mild penalty (prefer over easier)
    return 2 - d; // easier — bigger penalty (2-d > 2)
  };
  return pool.sort((a, b) => rank(a) - rank(b)).slice(0, k);
}

// ── Core generator ────────────────────────────────────────────────────────────

/**
 * Generate a draft ArtifactBundle using Claude Opus + Code Execution Tool.
 *
 * @param {{ role_track: string, drill_subtype: string, difficulty: string, language: string, topic_hint?: string, critique?: string }} params
 *   critique — optional feedback from a previous validation failure; appended to
 *              the user prompt so the model can correct identified issues.
 * @returns {Promise<object>}  Saved Mongoose document
 */
/**
 * Generate a new ArtifactBundle of either type.
 *
 * For drills: pass drill_subtype + difficulty + role_track + language.
 * For capstones: pass type='capstone' + role_track + language + difficulty
 *   + time_budget_minutes (60 | 75 | 90). drill_subtype is omitted.
 *
 * @param {{
 *   type?: 'drill' | 'capstone',
 *   role_track: string,
 *   drill_subtype?: string,
 *   difficulty: string,
 *   language: string,
 *   time_budget_minutes?: 60 | 75 | 90,
 *   topic_hint?: string,
 *   critique?: string,
 * }} opts
 */
async function generate({
  type = 'drill',
  role_track,
  drill_subtype,
  difficulty,
  language,
  time_budget_minutes,
  topic_hint,
  critique,
}) {
  if (type === 'drill' && !drill_subtype) {
    throw new Error('drill_subtype required when generating a drill bundle');
  }
  if (type === 'capstone' && !time_budget_minutes) {
    // Sensible default per difficulty.
    time_budget_minutes = difficulty === 'easy' ? 60 : difficulty === 'medium' ? 75 : 90;
  }

  const seeds = await nearestSeeds({ type, role_track, drill_subtype, difficulty });
  if (seeds.length === 0) {
    const key = type === 'capstone' ? `${type}/${role_track}/${difficulty}` : `${role_track}/${drill_subtype}/${difficulty}`;
    throw new Error(
      `No seed bundles found for ${key} — seed the library first`,
    );
  }

  // Strip large/internal fields from seeds — keep only what the model needs.
  // For capstones we keep starter_repo + hidden_tests because the generator
  // must produce both. For drills we omit them (drills rarely have starters).
  const seedExamples = seeds.map(s => ({
    type: s.type,
    drill_subtype: s.drill_subtype,
    role_track: s.role_track,
    language: s.language,
    difficulty: s.difficulty,
    time_budget_minutes: s.time_budget_minutes,
    brief: s.brief,
    acceptance_criteria: s.acceptance_criteria,
    starter_repo: type === 'capstone' ? s.starter_repo : undefined,
    reference_solution: s.reference_solution,
    visible_tests: type === 'capstone' ? s.visible_tests : undefined,
    hidden_tests: type === 'capstone' ? s.hidden_tests : undefined,
    seeded_mistakes: s.seeded_mistakes,
    rubric_anchors: s.rubric_anchors,
    expected_meta_skill_signals: s.expected_meta_skill_signals,
    difficulty_signals: s.difficulty_signals,
  }));

  const diffSpec = DIFFICULTY_SPEC[difficulty] || DIFFICULTY_SPEC.medium;
  const targetLines =
    type === 'capstone'
      ? [
          `- type: capstone`,
          `- role_track: ${role_track}`,
          `- language: ${language}`,
          `- difficulty: ${difficulty}`,
          `- time_budget_minutes: ${time_budget_minutes}`,
          `- starter_repo: REQUIRED (multi-file starting state for the learner)`,
          `- visible_tests: REQUIRED (3–5, distinct from hidden_tests)`,
          `- hidden_tests: REQUIRED — ${diffSpec.hidden_tests}`,
          `- seeded_mistakes: REQUIRED (${diffSpec.seeded_mistakes})`,
          `- difficulty_signals: REQUIRED — set edge_cases to the real count (>= ${diffSpec.min_edge_cases} for ${diffSpec.label}); set branching_complexity and token_count honestly`,
          `- rubric_anchors: REQUIRED (3–5 deterministic checks). Each anchor's "dimension" MUST be exactly one of: correctness, code_quality, ai_pair_effectiveness, verification_discipline, decomposition, reflection_quality (do not invent domain-specific dimension names).`,
        ]
      : [
          `- type: drill`,
          `- drill_subtype: ${drill_subtype}`,
          `- role_track: ${role_track}`,
          `- language: ${language}`,
          `- difficulty: ${difficulty}`,
        ];

  const userPrompt = `SEED EXAMPLES (${seeds.length}):
${JSON.stringify(seedExamples, null, 2)}

TARGET:
${targetLines.join('\n')}
${topic_hint ? `- topic_hint: ${topic_hint}` : ''}

${difficultyContractBlock(difficulty)}
${critique ? `\nCRITIQUE FROM PREVIOUS ATTEMPT:\n${critique}\n` : ''}
Generate a complete ArtifactBundle now. Return only the JSON.`;

  const res = await llmCall({
    taskId: 'content_generator_draft',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const draft = sanitizeDraft(extractJson(res.content));

  // Capstone hidden tests come from the INDEPENDENT model (different family
  // than the solution author) so the author's blind spots aren't baked into
  // the test suite. Fail-open: on error, keep the author's own hidden tests —
  // the sandbox validator still hard-gates everything either way.
  let hiddenTestModel = null;
  if (type === 'capstone') {
    try {
      const diffSpecMin = (DIFFICULTY_SPEC[difficulty] || DIFFICULTY_SPEC.medium).min_hidden_tests || 3;
      draft.hidden_tests = await generateIndependentHiddenTests(draft, { minCount: diffSpecMin });
      hiddenTestModel = require('./llmRouter').getModelForTask('hidden_test_generator').model;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[contentGenerator] independent hidden-test generation failed, keeping author tests:', err.message);
    }
  }

  // Stamp + hash + validate
  draft.content_hash = computeContentHash(draft);

  const { error, value } = validateBundle(draft);
  if (error) {
    const detail = error.details.map(d => d.message).join('; ');
    throw new Error(`Generator output failed Joi validation: ${detail}`);
  }

  value.generated_by = {
    generator_model: res._meta.model,
    // Non-null when hidden tests came from the independent (cross-family) model.
    hidden_test_model: hiddenTestModel,
    validator_model: null,
    validated_at: null,
    human_reviewed: false,
  };
  value.status = 'draft';

  const saved = await ArtifactBundle.create(value);

  // SOFT difficulty conformance — warn the operator (never block) when the
  // generated bundle falls short of its difficulty floor. Product decision is
  // warn-only, so a too-easy "hard" still ships but is visible for review.
  const conformance = checkDifficultyConformance(value);
  if (!conformance.ok) {
    void alerts
      .fire({
        category: 'content.difficulty-conformance',
        severity: 'warn',
        title: `Generated ${value.type} below '${value.difficulty}' difficulty floor`,
        detail: conformance.warnings.join('\n'),
        dedupKey: `${value.type}:${value.role_track}:${value.difficulty}`,
        fields: {
          bundle_id: String(saved._id),
          type: value.type,
          role_track: value.role_track,
          difficulty: value.difficulty,
        },
      })
      .catch(() => {});
  }

  return saved;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  generate,
  nearestSeeds,
  extractJson,
  checkDifficultyConformance,
  difficultyContractBlock,
  generateIndependentHiddenTests,
  DIFFICULTY_SPEC,
};
