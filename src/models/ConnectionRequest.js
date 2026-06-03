// src/models/ConnectionRequest.js
'use strict';
const mongoose = require('mongoose');

// Gate-3: an employer's interest in a candidate. Identity/contact is revealed
// (by connectionViewService) ONLY when status === 'approved'.
const ConnectionRequestSchema = new mongoose.Schema(
  {
    employerId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployerAccount', required: true, index: true },
    candidateUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    talentProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'TalentProfile', required: true },
    objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective' },
    roleContext: { type: String, trim: true },   // what the employer is hiring for
    message: { type: String, trim: true },        // employer's note to the candidate
    status: { type: String, enum: ['requested', 'approved', 'declined', 'expired'], default: 'requested', index: true },
    respondedAt: { type: Date },
  },
  { timestamps: true }
);
// idempotency: one live request per (employer, candidate, objective)
ConnectionRequestSchema.index({ employerId: 1, candidateUserId: 1, objectiveId: 1 }, { unique: true });

module.exports = mongoose.model('ConnectionRequest', ConnectionRequestSchema);
