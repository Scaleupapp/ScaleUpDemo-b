'use strict';

const mongoose = require('mongoose');

const EvaluationAnchorSchema = new mongoose.Schema({
  bundle_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtifactBundle', required: true, index: true },
  anchor_id: { type: String, required: true },
  expected_score: { type: Number, required: true },
  observed_scores: [{
    score: Number,
    drift: Number,
    observed_at: Date,
    grader_model: String,
  }],
}, { timestamps: true });

EvaluationAnchorSchema.index({ bundle_id: 1, anchor_id: 1 }, { unique: true });

module.exports = mongoose.model('EvaluationAnchor', EvaluationAnchorSchema);
