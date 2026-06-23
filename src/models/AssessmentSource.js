'use strict';
const mongoose = require('mongoose');

const AssessmentSourceSchema = new mongoose.Schema({
  institutionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Institution',
    required: true,
    index: true,
  },
  cohortId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InstitutionCohort',
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InstitutionUser',
    required: true,
  },
  filename: {
    type: String,
    required: true,
    trim: true,
  },
  mimeType: {
    type: String,
    required: true,
  },
  s3Key: {
    type: String,
  },
  status: {
    type: String,
    enum: ['uploaded', 'extracting', 'ready', 'failed'],
    default: 'uploaded',
  },
  extractedText: {
    type: String,
  },
  extractedTopics: [
    {
      _id: false,
      name: { type: String },
    },
  ],
  error: {
    type: String,
  },
}, { timestamps: true });

AssessmentSourceSchema.index({ institutionId: 1, status: 1 });

module.exports =
  mongoose.models.AssessmentSource ||
  mongoose.model('AssessmentSource', AssessmentSourceSchema);
