'use strict';

const Joi = require('joi');

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const fileNodeSchema = Joi.object({
  path: Joi.string().required(),
  content: Joi.string().required().allow(''),
});

const testSpecSchema = Joi.object({
  name: Joi.string().required(),
  command: Joi.string().required(),
  expected_exit_code: Joi.number().integer().default(0),
  expected_output_contains: Joi.array().items(Joi.string()).default([]),
});

const seededMistakeSchema = Joi.object({
  location: Joi.string().required(),
  bug_description: Joi.string().required(),
  why_compass_might_suggest_it: Joi.string().allow('').optional(),
  detection_signals: Joi.array().items(Joi.string()).default([]),
});

const rubricAnchorSchema = Joi.object({
  dimension: Joi.string().valid(
    'correctness',
    'code_quality',
    'ai_pair_effectiveness',
    'verification_discipline',
    'decomposition',
    'reflection_quality',
  ).required(),
  check: Joi.string().required(),
  deterministic_test: Joi.string().optional(),
  weight: Joi.number().required(),
  // Optional baseline a passing solution should score on this dimension
  // (0..10). Drives the WS4 anchor-drift detector — evaluator scores
  // diverging from expected_score by > 2 points trigger a strict re-run
  // + HumanReviewQueue entry (spec §8.3).
  expected_score: Joi.number().min(0).max(10).optional(),
});

// ---------------------------------------------------------------------------
// Root bundle schema
// ---------------------------------------------------------------------------

const bundleSchema = Joi.object({
  version: Joi.number().integer().default(1),

  // Type / subtype
  type: Joi.string().valid('drill', 'capstone').required(),
  drill_subtype: Joi.string().valid('prompt', 'verify', 'decompose', 'refactor').when('type', {
    is: 'drill',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),

  // Classification
  role_track: Joi.string().valid('swe', 'ds', 'ai_eng').required(),
  language: Joi.string().valid('python', 'javascript', 'typescript', 'java', 'sql').required(),
  stack_variant: Joi.string().optional(),
  difficulty: Joi.string().valid('easy', 'medium', 'hard').required(),
  time_budget_minutes: Joi.number().integer().min(1).max(180).required(),

  // Content
  brief: Joi.string().min(10).required(),
  acceptance_criteria: Joi.array().items(Joi.string()).default([]),
  starter_repo: Joi.object({
    files: Joi.array().items(fileNodeSchema).default([]),
  }).optional(),
  reference_solution: Joi.object({
    files: Joi.array().items(fileNodeSchema).default([]),
  }).required(),
  visible_tests: Joi.array().items(testSpecSchema).default([]),
  hidden_tests: Joi.array().items(testSpecSchema).default([]),
  seeded_mistakes: Joi.array().items(seededMistakeSchema).default([]),
  rubric_anchors: Joi.array().items(rubricAnchorSchema).default([]),

  // Pedagogy
  expected_meta_skill_signals: Joi.object({
    good_prompts_look_like: Joi.array().items(Joi.string()).default([]),
    common_verification_traps: Joi.array().items(Joi.string()).default([]),
    decomposition_reference: Joi.array().items(Joi.string()).default([]),
  }).required(),

  // Difficulty signals
  difficulty_signals: Joi.object({
    token_count: Joi.number().integer().min(0).required(),
    branching_complexity: Joi.number().integer().min(0).required(),
    edge_cases: Joi.number().integer().min(0).required(),
    known_hard_patterns: Joi.array().items(Joi.string()).default([]),
  }).required(),

  // Optional metadata
  interview_parallel: Joi.string().optional(),
  content_hash: Joi.string().required(),
  status: Joi.string().valid('draft', 'validated', 'active', 'retired').optional(),
  generated_by: Joi.object({
    generator_model: Joi.string().allow(null).optional(),
    validator_model: Joi.string().allow(null).optional(),
    validated_at: Joi.date().allow(null).optional(),
    human_reviewed: Joi.boolean().optional(),
  }).optional(),
}).unknown(false); // strict — reject unknown top-level fields

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an ArtifactBundle payload against the Joi schema.
 * Returns Joi's standard { error, value } result object.
 *
 * @param {object} payload
 * @returns {{ error?: import('joi').ValidationError, value: object }}
 */
function validateBundle(payload) {
  return bundleSchema.validate(payload, { abortEarly: false });
}

module.exports = { bundleSchema, validateBundle };
