// src/models/TalentProfile.js
'use strict';
const mongoose = require('mongoose');

// The consented, employer-discoverable projection of a candidate's career objective.
// Exists only when a learner opts in. `snapshot` is denormalized from the live readiness
// data (built by reusing proofService.buildSnapshot) so search/rank is O(1).
const TalentProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', required: true },

    // consent (candidate-owned)
    optedIn: { type: Boolean, default: false },
    optedInAt: { type: Date },
    status: { type: String, enum: ['active', 'paused'], default: 'active' },

    // recruiter-facing preferences (candidate-supplied)
    city: { type: String },
    noticePeriod: { type: String },
    workPref: { type: String, enum: ['onsite', 'remote', 'hybrid', 'any'], default: 'any' },

    // denormalized searchable snapshot (refreshed on key events)
    snapshot: {
      roleLabel: String,
      objectiveType: String,
      targetCompany: String,
      readinessBand: String,
      readinessScore: Number,
      target: Number,
      competencies: [{ name: String, score: Number, _id: false }],
      evidence: {
        assessments: { type: Number, default: 0 },
        capstonesGraded: { type: Number, default: 0 },
        interviews: { type: Number, default: 0 },
        coveragePct: { type: Number, default: null },
      },
      codingMastery: { type: mongoose.Schema.Types.Mixed, default: null },
      achieved: { type: Boolean, default: false },
      verified: { type: Boolean, default: false },
      proofToken: { type: String, default: null },
      lastActiveAt: { type: Date },
    },
    refreshedAt: { type: Date },
  },
  { timestamps: true }
);
// one talent profile per (user, objective)
TalentProfileSchema.index({ userId: 1, objectiveId: 1 }, { unique: true });
// search uses these (Phase 2)
TalentProfileSchema.index({ optedIn: 1, status: 1, 'snapshot.objectiveType': 1, 'snapshot.readinessScore': -1 });

module.exports = mongoose.model('TalentProfile', TalentProfileSchema);
