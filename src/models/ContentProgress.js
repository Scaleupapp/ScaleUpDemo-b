const mongoose = require('mongoose');

const contentProgressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },

  // --- Progress ---
  percentageCompleted: { type: Number, default: 0, min: 0, max: 100 },
  currentPosition: { type: Number, default: 0 },
  totalDuration: { type: Number },
  isCompleted: { type: Boolean, default: false },
  completedAt: { type: Date },

  // --- Time ---
  totalTimeSpent: { type: Number, default: 0 },
  sessionCount: { type: Number, default: 0 },
  lastSessionAt: { type: Date },
  firstViewedAt: { type: Date, default: Date.now },

  // --- Engagement ---
  liked: { type: Boolean, default: false },
  saved: { type: Boolean, default: false },
  rated: { type: Number, min: 1, max: 5 },
  commented: { type: Boolean, default: false },
}, { timestamps: true });

contentProgressSchema.index({ userId: 1, contentId: 1 }, { unique: true });
contentProgressSchema.index({ userId: 1, isCompleted: 1, completedAt: -1 });

module.exports = mongoose.model('ContentProgress', contentProgressSchema);
