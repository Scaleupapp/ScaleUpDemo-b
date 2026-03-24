const mongoose = require('mongoose');

const leaderboardEntrySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  totalHandicappedScore: { type: Number, default: 0 },
  challengesCompleted: { type: Number, default: 0 },
  bestDayScore: { type: Number, default: 0 },
  rank: { type: Number },
  percentile: { type: Number },
}, { _id: false });

const weeklyLeaderboardSchema = new mongoose.Schema({
  topic: { type: String, required: true },
  weekStart: { type: Date, required: true },
  weekEnd: { type: Date, required: true },
  entries: [leaderboardEntrySchema],
  finalized: { type: Boolean, default: false },
  participantCount: { type: Number, default: 0 },
}, { timestamps: true });

weeklyLeaderboardSchema.index({ topic: 1, weekStart: 1 }, { unique: true });

module.exports = mongoose.model('WeeklyLeaderboard', weeklyLeaderboardSchema);
