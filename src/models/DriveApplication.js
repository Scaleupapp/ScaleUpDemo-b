'use strict';
const mongoose = require('mongoose');

const DriveApplicationSchema = new mongoose.Schema(
  {
    institutionId: { type: String, required: true, index: true },
    cohortId:      { type: String, required: true, index: true },
    driveId:       { type: mongoose.Schema.Types.ObjectId, ref: 'PlacementDrive', required: true, index: true },
    studentName:   { type: String, required: true },
    rollNumber:    { type: String },
    studentUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    stage: {
      type: String,
      enum: ['interested', 'applied', 'shortlisted', 'offered', 'rejected'],
      default: 'interested',
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
  },
  { timestamps: true }
);

// Unique sparse index: a student (by rollNumber) can only appear once per drive
DriveApplicationSchema.index({ driveId: 1, rollNumber: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.DriveApplication || mongoose.model('DriveApplication', DriveApplicationSchema);
