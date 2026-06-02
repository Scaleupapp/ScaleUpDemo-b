'use strict';
const mongoose = require('mongoose');

/**
 * A frozen, shareable proof of readiness. Created at publish time from the
 * served readiness; never recomputed (the whole point — a dated credential).
 * Opt-in + revocable, mirroring coding/models/shareToken.model.js.
 */
const ReadinessProofSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', required: true },
    active: { type: Boolean, default: true, index: true },
    issuedAt: { type: Date, default: Date.now },
    viewCount: { type: Number, default: 0 },
    snapshot: {
      displayName: String,
      avatarURL: String,
      objectiveLabel: String,
      score: Number,
      target: Number,
      band: String, // 'Competitive' | 'Strong' | 'Exceptional'
      competencies: [{ name: String, score: Number, assessed: Boolean }],
      evidence: {
        assessments: Number,
        capstonesGraded: Number,
        coveragePct: Number,
        hoursInvested: Number,
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReadinessProof', ReadinessProofSchema);
