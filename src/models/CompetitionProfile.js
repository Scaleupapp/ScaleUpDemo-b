const mongoose = require('mongoose');

const personalBestSchema = new mongoose.Schema({
  bestDailyScore: { type: Number, default: 0 },
  bestDailyDate: { type: Date },
  bestWeeklyScore: { type: Number, default: 0 },
  bestWeeklyWeekStart: { type: Date },
}, { _id: false });

const competitionProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  personalBests: { type: Map, of: personalBestSchema, default: {} },
  totalChallengesCompleted: { type: Number, default: 0 },
  currentChallengeStreak: { type: Number, default: 0 },
  longestChallengeStreak: { type: Number, default: 0 },
  titlesEarned: [{
    title: String,
    earnedAt: Date,
    topic: String,
  }],
}, { timestamps: true });

module.exports = mongoose.model('CompetitionProfile', competitionProfileSchema);
