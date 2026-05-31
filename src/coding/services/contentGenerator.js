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

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You generate ArtifactBundles for ScaleUp coding practice. Output STRICT JSON matching the schema you see in the seed examples. Use the seeds as quality + format reference, but produce a NEW problem (different brief, different code) at the same difficulty level.

Hard requirements:
- type must match what was requested
- role_track, language, difficulty, drill_subtype must match the target spec
- reference_solution must be a complete, working solution that passes every visible_test and hidden_test (it will be executed in a sandbox to verify, so it must actually run)
- THE PROJECT MUST BE SELF-CONTAINED AND INSTALLABLE IN A CLEAN SANDBOX with only \`npm install\` / \`pip install\` (no preinstalled global tools). If a test script invokes a tool (jest, mocha, vitest, pytest, supertest, etc.), that tool MUST be declared in the dependency manifest's devDependencies/dev-requirements with a REAL, published, stable version. Never reference a binary you have not declared.
- starter_repo MUST include the dependency manifest (package.json / requirements.txt / go.mod …) AND the test files. reference_solution contains the COMPLETED source files that OVERLAY starter_repo (you need not repeat unchanged starter files); the MERGED project must \`install\` cleanly and then pass the test command.
- pin dependency versions to well-known existing releases; do not invent versions or use "latest"
- visible_tests and hidden_tests must be distinct
- seeded_mistakes (where applicable) must each be a plausible bug Compass might suggest
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

/**
 * Coerce the model's minor schema deviations so a single stray field doesn't
 * fail the whole generation. The sandbox proof (reference solution passes the
 * tests) is the real guarantee; these are cosmetic/enum slips.
 *
 * Today: rubric_anchor dimensions sometimes come back as invented,
 * domain-specific names (e.g. "query_accuracy") — coerce those to the closest
 * valid dimension ('correctness') rather than reject the bundle.
 */
function sanitizeDraft(draft) {
  if (!draft || typeof draft !== 'object') return draft;
  if (Array.isArray(draft.rubric_anchors)) {
    draft.rubric_anchors = draft.rubric_anchors.map((a) =>
      a && typeof a === 'object' && !RUBRIC_DIMS.includes(a.dimension)
        ? { ...a, dimension: 'correctness' }
        : a
    );
  }
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

  // Fallback: drop difficulty constraint.
  const fallback = await ArtifactBundle.find(baseFilter).limit(k).lean();

  return fallback;
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

  const targetLines =
    type === 'capstone'
      ? [
          `- type: capstone`,
          `- role_track: ${role_track}`,
          `- language: ${language}`,
          `- difficulty: ${difficulty}`,
          `- time_budget_minutes: ${time_budget_minutes}`,
          `- starter_repo: REQUIRED (multi-file starting state for the learner)`,
          `- visible_tests + hidden_tests: REQUIRED (3–5 each; distinct)`,
          `- seeded_mistakes: REQUIRED (1–2 plausible bugs)`,
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
${critique ? `\nCRITIQUE FROM PREVIOUS ATTEMPT:\n${critique}\n` : ''}
Generate a complete ArtifactBundle now. Return only the JSON.`;

  const res = await llmCall({
    taskId: 'content_generator_draft',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const draft = sanitizeDraft(extractJson(res.content));

  // Stamp + hash + validate
  draft.content_hash = computeContentHash(draft);

  const { error, value } = validateBundle(draft);
  if (error) {
    const detail = error.details.map(d => d.message).join('; ');
    throw new Error(`Generator output failed Joi validation: ${detail}`);
  }

  value.generated_by = {
    generator_model: res._meta.model,
    validator_model: null,
    validated_at: null,
    human_reviewed: false,
  };
  value.status = 'draft';

  const saved = await ArtifactBundle.create(value);
  return saved;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { generate, nearestSeeds, extractJson };
