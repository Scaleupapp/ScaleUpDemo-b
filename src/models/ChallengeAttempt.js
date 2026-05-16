const mongoose = require('mongoose');

const challengeAttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  challengeId: { type: mongoose.Schema.Types.ObjectId, ref: 'DailyChallenge', required: true, index: true },
  answers: [{
    questionIndex: { type: Number, required: true },
    selectedAnswer: { type: String, enum: ['A', 'B', 'C', 'D'] },
    timeSpent: { type: Number },
    answeredAt: { type: Date },
  }],
  rawScore: { type: Number, min: 0, max: 100 },
  handicappedScore: { type: Number },
  timeTaken: { type: Number },
  isPersonalBest: { type: Boolean, default: false },
  completedAt: { type: Date },
  questionOrder: [{ type: Number }],
  optionOrders: [[{ type: String }]],
  optionLabelMap: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });

challengeAttemptSchema.index({ userId: 1, challengeId: 1 }, { unique: true });

module.exports = mongoose.model('ChallengeAttempt', challengeAttemptSchema);
