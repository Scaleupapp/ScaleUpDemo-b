'use strict';

const mongoose = require('mongoose');

const FileNodeSchema = new mongoose.Schema({
  path: { type: String, required: true },
  content: { type: String, required: true },
}, { _id: false });

const TestSpecSchema = new mongoose.Schema({
  name: { type: String, required: true },
  command: { type: String, required: true },
  expected_exit_code: { type: Number, default: 0 },
  expected_output_contains: [String],
}, { _id: false });

const SeededMistakeSchema = new mongoose.Schema({
  location: { type: String, required: true },
  bug_description: { type: String, required: true },
  why_compass_might_suggest_it: String,
  detection_signals: [String],
}, { _id: false });

const RubricAnchorSchema = new mongoose.Schema({
  dimension: {
    type: String,
    enum: ['correctness', 'code_quality', 'ai_pair_effectiveness',
           'verification_discipline', 'decomposition', 'reflection_quality'],
    required: true,
  },
  check: { type: String, required: true },
  deterministic_test: String,
  weight: { type: Number, required: true },
}, { _id: false });

const ArtifactBundleSchema = new mongoose.Schema({
  version: { type: Number, default: 1 },
  type: { type: String, enum: ['drill', 'capstone'], required: true },
  drill_subtype: { type: String, enum: ['prompt', 'verify', 'decompose', 'refactor'] },
  role_track: { type: String, enum: ['swe', 'ds', 'ai_eng'], required: true },
  language: { type: String, enum: ['python', 'javascript', 'typescript', 'java', 'sql'], required: true },
  stack_variant: String,
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], required: true },
  time_budget_minutes: { type: Number, required: true },
  brief: { type: String, required: true },
  acceptance_criteria: [String],
  starter_repo: { files: [FileNodeSchema] },
  reference_solution: { files: [FileNodeSchema] },
  visible_tests: [TestSpecSchema],
  hidden_tests: [TestSpecSchema],
  seeded_mistakes: [SeededMistakeSchema],
  rubric_anchors: [RubricAnchorSchema],
  expected_meta_skill_signals: {
    good_prompts_look_like: [String],
    common_verification_traps: [String],
    decomposition_reference: [String],
  },
  difficulty_signals: {
    token_count: Number,
    branching_complexity: Number,
    edge_cases: Number,
    known_hard_patterns: [String],
  },
  interview_parallel: String,
  content_hash: { type: String, required: true, index: true },
  status: { type: String, enum: ['draft', 'validated', 'active', 'retired'], default: 'draft' },
  generated_by: {
    generator_model: String,
    validator_model: String,
    validated_at: Date,
    human_reviewed: { type: Boolean, default: false },
  },
}, { timestamps: true });

ArtifactBundleSchema.index({ type: 1, role_track: 1, difficulty: 1, status: 1 });
ArtifactBundleSchema.index({ drill_subtype: 1, status: 1 });

module.exports = mongoose.model('ArtifactBundle', ArtifactBundleSchema);
