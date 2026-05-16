const mongoose = require('mongoose');

const personaGhostSchema = new mongoose.Schema({
  name: { type: String, required: true },
  medianOffset: { type: Number, required: true },
  seed: { type: String, required: true },
}, { _id: false });

const historicalStatsSchema = new mongoose.Schema({
  last30dAverageScore: { type: Number, default: 0 },
  last30dP90Score: { type: Number, default: 0 },
  sampleSize: { type: Number, default: 0 },
  refreshedAt: { type: Date },
}, { _id: false });

const cohortDirectorySchema = new mongoose.Schema({
  canonicalTopic: { type: String, required: true, unique: true, index: true, lowercase: true },
  displayName: { type: String },
  objectiveTypes: [{ type: String }],
  memberCount: { type: Number, default: 0, min: 0 },
  weeklyAttempts: { type: Number, default: 0, min: 0 },
  lastChallengeDate: { type: Date },
  lastAttemptAt: { type: Date },
  isActive: { type: Boolean, default: true, index: true },
  personaGhosts: { type: [personaGhostSchema], default: [] },
  historicalStats: { type: historicalStatsSchema, default: () => ({}) },
}, { timestamps: true });

module.exports = mongoose.model('CohortDirectory', cohortDirectorySchema);
