'use strict';

const mongoose = require('mongoose');

const DrillAttemptSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  bundle_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtifactBundle', required: true },
  status: { type: String, enum: ['scheduled', 'in_progress', 'submitted', 'graded'], default: 'scheduled' },
  started_at: Date,
  submitted_at: Date,
  time_taken_seconds: Number,
  submission: {
    prompt_text: String,
    bug_locations: [{ file: String, line: Number, explanation: String }],
    decomposition_steps: [{ step: String, rationale: String }],
    refactored_code: { files: [{ path: String, content: String }] },
  },
  grade: {
    overall_score: Number,
    rubric_breakdown: [{ dimension: String, score: Number, feedback: String }],
    what_to_try_next: String,
    integrity_confidence: { type: String, enum: ['high', 'medium', 'low'] },
    graded_at: Date,
    grader_model: String,
  },
  is_calibration: { type: Boolean, default: false },
}, { timestamps: true });

DrillAttemptSchema.index({ user_id: 1, createdAt: -1 });

module.exports = mongoose.model('DrillAttempt', DrillAttemptSchema);
