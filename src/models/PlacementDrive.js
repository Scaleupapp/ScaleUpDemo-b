'use strict';
const mongoose = require('mongoose');

const PlacementDriveSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true, index: true },
  name: { type: String, required: true, trim: true },
  role: { type: String, trim: true },
  package: { type: String, trim: true },
  driveDate: { type: Date },
  eligibility: { type: String, trim: true },
  status: { type: String, enum: ['upcoming', 'open', 'closed', 'visited'], default: 'upcoming' },
  applyLink: { type: String, trim: true },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });

PlacementDriveSchema.index({ institutionId: 1, cohortId: 1 });

module.exports = mongoose.models.PlacementDrive || mongoose.model('PlacementDrive', PlacementDriveSchema);
