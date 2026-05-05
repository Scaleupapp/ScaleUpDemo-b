const mongoose = require('mongoose');

const companyProfileSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    normalizedName: { type: String, required: true, lowercase: true, trim: true },
    industry: { type: String, required: true },
    applicableObjectives: { type: [String], default: [] },
    signatureInterviewElements: { type: [String], default: [] },
    topicWeightOverrides: { type: Map, of: Number, default: () => new Map() },
    examplesContext: { type: String, default: '' },
    source: {
      type: String,
      enum: ['curated', 'llm-generated'],
      required: true,
    },
    lastRefreshedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

companyProfileSchema.index({ normalizedName: 1 }, { unique: true });

module.exports = mongoose.model('CompanyProfile', companyProfileSchema);
