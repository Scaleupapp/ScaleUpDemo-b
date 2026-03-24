const mongoose = require('mongoose');

const liveEventSchema = new mongoose.Schema({
  topic: { type: String, required: true, index: true },
  scheduledAt: { type: Date, required: true, index: true },
  questions: [{
    questionText: String,
    questionType: { type: String, enum: ['recall', 'application', 'conceptual', 'critical_thinking'] },
    options: [{ label: String, text: String }],
    correctAnswer: { type: String, enum: ['A', 'B', 'C', 'D'] },
    explanation: String,
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
    concept: String,
  }],
  status: { type: String, enum: ['scheduled', 'lobby', 'live', 'completed'], default: 'scheduled' },
  participantCount: { type: Number, default: 0 },
  startedAt: { type: Date },
  completedAt: { type: Date },
  duration: { type: Number },
  leaderboard: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    handicappedScore: Number,
    rawScore: Number,
    timeTaken: Number,
    rank: Number,
    completedAt: Date,
  }],
}, { timestamps: true });

module.exports = mongoose.model('LiveEvent', liveEventSchema);
