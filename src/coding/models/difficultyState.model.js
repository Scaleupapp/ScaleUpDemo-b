'use strict';

const mongoose = require('mongoose');

const DifficultyStateSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role_track: { type: String, enum: ['swe', 'ds', 'ai_eng'], required: true },
  current_difficulty: { type: String, enum: ['easy', 'medium', 'hard'], required: true },
  recommendation_history: [{
    recommended: { type: String, enum: ['easy', 'medium', 'hard'] },
    reason: String,
    accepted: Boolean,
    timestamp: Date,
  }],
}, { timestamps: true });

DifficultyStateSchema.index({ user_id: 1, role_track: 1 }, { unique: true });

module.exports = mongoose.model('DifficultyState', DifficultyStateSchema);
