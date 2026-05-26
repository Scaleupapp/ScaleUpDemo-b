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
- reference_solution must be a complete, working solution (you may run it in a code_execution tool first to verify)
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
  let text = textBlock.text;
  // Strip ```json ... ``` fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1];
  return JSON.parse(text.trim());
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
async function nearestSeeds({ role_track, drill_subtype, difficulty }, k = 3) {
  const exactMatch = await ArtifactBundle.find({
    type: 'drill',
    role_track,
    drill_subtype,
    difficulty,
    status: 'active',
    'generated_by.human_reviewed': true,
  }).limit(k).lean();

  if (exactMatch.length >= k) return exactMatch;

  // Fallback: same role_track + drill_subtype, any difficulty
  const fallback = await ArtifactBundle.find({
    type: 'drill',
    role_track,
    drill_subtype,
    status: 'active',
    'generated_by.human_reviewed': true,
  }).limit(k).lean();

  return fallback;
}

// ── Core generator ────────────────────────────────────────────────────────────

/**
 * Generate a draft ArtifactBundle using Claude Opus + Code Execution Tool.
 *
 * @param {{ role_track: string, drill_subtype: string, difficulty: string, language: string, topic_hint?: string }} params
 * @returns {Promise<object>}  Saved Mongoose document
 */
async function generate({ role_track, drill_subtype, difficulty, language, topic_hint }) {
  const seeds = await nearestSeeds({ role_track, drill_subtype, difficulty });
  if (seeds.length === 0) {
    throw new Error(
      `No seed bundles found for ${role_track}/${drill_subtype}/${difficulty} — seed the library first`,
    );
  }

  // Strip large/internal fields from seeds — keep only what the model needs
  const seedExamples = seeds.map(s => ({
    type: s.type,
    drill_subtype: s.drill_subtype,
    role_track: s.role_track,
    language: s.language,
    difficulty: s.difficulty,
    time_budget_minutes: s.time_budget_minutes,
    brief: s.brief,
    acceptance_criteria: s.acceptance_criteria,
    reference_solution: s.reference_solution,
    seeded_mistakes: s.seeded_mistakes,
    rubric_anchors: s.rubric_anchors,
    expected_meta_skill_signals: s.expected_meta_skill_signals,
    difficulty_signals: s.difficulty_signals,
  }));

  const userPrompt = `SEED EXAMPLES (${seeds.length}):
${JSON.stringify(seedExamples, null, 2)}

TARGET:
- type: drill
- drill_subtype: ${drill_subtype}
- role_track: ${role_track}
- language: ${language}
- difficulty: ${difficulty}
${topic_hint ? `- topic_hint: ${topic_hint}` : ''}

Generate a complete ArtifactBundle now. Return only the JSON.`;

  const res = await llmCall({
    taskId: 'content_generator_draft',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const draft = extractJson(res.content);

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
