// src/models/MarketplaceAuditLog.js
'use strict';
const mongoose = require('mongoose');

// DPDP audit trail for the talent marketplace: who viewed/contacted/was-revealed, when.
const MarketplaceAuditLogSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['view', 'interest', 'reveal'], required: true, index: true },
    actorType: { type: String, enum: ['employer', 'candidate', 'system'], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    subjectUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // the candidate
    talentProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'TalentProfile' },
    connectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectionRequest' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);
MarketplaceAuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('MarketplaceAuditLog', MarketplaceAuditLogSchema);
