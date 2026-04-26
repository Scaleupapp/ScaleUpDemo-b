const mongoose = require('mongoose');

/**
 * ConceptPrerequisite — BUG-8 Phase 7
 *
 * One document per concept. Stores the prerequisite concepts that should
 * be solid before this one will click. Used by the Insights service to
 * walk backward from a struggling concept to the root cause.
 *
 * Each prerequisite carries `weight` (0..1) — how strong the dependency
 * is. 1.0 means "you cannot understand X without Y"; 0.5 means "Y helps
 * but isn't strictly required".
 *
 * Source can be 'gpt_auto' (extracted by the LLM on first encounter)
 * or 'curated' (human-reviewed). The Insights traversal weights curated
 * higher.
 */

const prerequisiteEdgeSchema = new mongoose.Schema({
  prerequisite: { type: String, required: true, lowercase: true },
  weight:       { type: Number, default: 0.7, min: 0, max: 1 },
}, { _id: false });

const conceptPrerequisiteSchema = new mongoose.Schema({
  concept:       { type: String, required: true, unique: true, lowercase: true, index: true },
  domain:        { type: String, lowercase: true }, // best-effort parent domain
  prerequisites: [prerequisiteEdgeSchema],

  source:        { type: String, enum: ['gpt_auto', 'curated'], default: 'gpt_auto' },
  extractionAttempts: { type: Number, default: 0 }, // for retry/backoff
  lastExtractedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('ConceptPrerequisite', conceptPrerequisiteSchema);
