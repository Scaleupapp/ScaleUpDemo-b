const mongoose = require('mongoose');

const liveEventAttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveEvent', required: true, index: true },
  answers: [{
    questionIndex: { type: Number, required: true },
    selectedAnswer: { type: String, enum: ['A', 'B', 'C', 'D'] },
    timeSpent: { type: Number },
    answeredAt: { type: Date },
  }],
  rawScore: { type: Number, min: 0, max: 100 },
  handicappedScore: { type: Number },
  timeTaken: { type: Number },
  rank: { type: Number },
  completedAt: { type: Date },
  questionOrder: [Number],
  optionOrders: [[String]],
}, { timestamps: true });

liveEventAttemptSchema.index({ userId: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.model('LiveEventAttempt', liveEventAttemptSchema);
