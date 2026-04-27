const mongoose = require('mongoose');

/**
 * DiagnosticQuestionBank — pool of reusable diagnostic questions, keyed by
 * (canonicalCompetency, difficulty). Populated organically as users complete
 * diagnostics: each attempt's unused pool questions land here for future use.
 *
 * `discrimination` is reserved for v2 — a future analytics job will populate it
 * once we have enough attempts per question to compute item-discrimination scores.
 */

const optionSchema = new mongoose.Schema({
  label: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  text:  { type: String, required: true },
  misconception: {
    tag:         { type: String },
    explanation: { type: String },
  },
}, { _id: false });

const diagnosticQuestionBankSchema = new mongoose.Schema({
  canonicalCompetency:  { type: String, required: true, lowercase: true, index: true },
  rawCompetencyAliases: [{ type: String }],
  difficulty:           { type: String, enum: ['easy', 'medium', 'hard'], required: true, index: true },

  questionText: { type: String, required: true },
  options:      [optionSchema],
  correctAnswer:{ type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  explanation:  { type: String },

  source:      { type: String, enum: ['live_generated', 'curated', 'cached'], default: 'live_generated' },
  generatedAt: { type: Date, default: Date.now },
  timesUsed:   { type: Number, default: 0 },
  discrimination: { type: Number, default: null }, // v2 — populated by future analytics job
  status: { type: String, enum: ['active', 'retired', 'pending_review'], default: 'active' },
}, { timestamps: true });

diagnosticQuestionBankSchema.index({ canonicalCompetency: 1, difficulty: 1, status: 1, timesUsed: 1 });

module.exports = mongoose.model('DiagnosticQuestionBank', diagnosticQuestionBankSchema);
