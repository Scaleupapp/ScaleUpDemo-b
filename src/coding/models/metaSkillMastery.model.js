'use strict';

const mongoose = require('mongoose');

const MetaSkillMasterySchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role_track: { type: String, enum: ['swe', 'ds', 'ai_eng'], required: true },
  axes: {
    prompting: { type: Number, default: 0, min: 0, max: 100 },
    verification: { type: Number, default: 0, min: 0, max: 100 },
    decomposition: { type: Number, default: 0, min: 0, max: 100 },
    refactoring: { type: Number, default: 0, min: 0, max: 100 },
  },
  confidence: { type: Number, default: 0, min: 0, max: 1 },
  attempt_count: { type: Number, default: 0 },
  last_updated: { type: Date, default: Date.now },
}, { timestamps: true });

MetaSkillMasterySchema.index({ user_id: 1, role_track: 1 }, { unique: true });

module.exports = mongoose.model('MetaSkillMastery', MetaSkillMasterySchema);
