'use strict';

const mongoose = require('mongoose');

const HumanReviewQueueSchema = new mongoose.Schema({
  bundle_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtifactBundle', required: true },
  reason: { type: String, required: true },
  validator_errors: [String],
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  reviewer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  review_notes: String,
  reviewed_at: Date,
}, { timestamps: true });

module.exports = mongoose.model('HumanReviewQueue', HumanReviewQueueSchema);
