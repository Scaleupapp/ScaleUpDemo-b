const mongoose = require('mongoose');

const endorsementSchema = new mongoose.Schema({
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  creatorTier: { type: String, enum: ['rising', 'core', 'anchor'], required: true },
  note: { type: String, maxlength: 500 },
  endorsedAt: { type: Date, default: Date.now },
}, { _id: false });

const creatorApplicationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // --- Application Details ---
  domain: { type: String, required: true, lowercase: true, trim: true },
  specializations: [{ type: String, lowercase: true, trim: true }],
  experience: { type: String, maxlength: 2000 },
  sampleContentLinks: [{ type: String }],
  motivation: { type: String, maxlength: 1000 },
  portfolioUrl: { type: String },
  socialLinks: {
    linkedin: { type: String },
    twitter: { type: String },
    youtube: { type: String },
    website: { type: String },
  },

  // --- Peer Endorsement-Based Approval ---
  // Approved when: 2 core creators endorse OR 1 anchor creator endorses (same domain)
  endorsements: [endorsementSchema],

  status: {
    type: String,
    enum: ['pending', 'endorsed', 'approved', 'rejected'],
    default: 'pending',
  },

  // Tier assigned on approval — all new creators start as 'rising'
  approvedTier: { type: String, enum: ['rising'], default: 'rising' },

  // Rejection details (peer rejection by core/anchor)
  rejectionNote: { type: String },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reapplyAfter: { type: Date },

  // Admin can still override (reject spam applications)
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewNote: { type: String },
  reviewedAt: { type: Date },
}, { timestamps: true });

creatorApplicationSchema.index({ userId: 1, status: 1 });
creatorApplicationSchema.index({ status: 1, createdAt: -1 });
creatorApplicationSchema.index({ domain: 1, status: 1 });

module.exports = mongoose.model('CreatorApplication', creatorApplicationSchema);
