const mongoose = require('mongoose');

const challengeQuestionSchema = new mongoose.Schema({
  questionText: { type: String, required: true },
  questionType: {
    type: String,
    enum: ['recall', 'application', 'conceptual', 'critical_thinking'],
    default: 'conceptual',
  },
  options: [{
    label: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
    text: { type: String, required: true },
  }],
  correctAnswer: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  explanation: { type: String },
  concept: { type: String },
}, { _id: true });

const dailyChallengeSchema = new mongoose.Schema({
  topic: { type: String, required: true, index: true },
  date: { type: Date, required: true, index: true },
  questions: { type: [challengeQuestionSchema], validate: [arr => arr.length === 15, 'Must have exactly 15 questions'] },
  status: { type: String, enum: ['active', 'closed'], default: 'active' },
  participantCount: { type: Number, default: 0 },
  timeLimitSeconds: { type: Number, default: 720 },
  activatesAt: { type: Date },
  closesAt: { type: Date },
}, { timestamps: true });

dailyChallengeSchema.index({ topic: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyChallenge', dailyChallengeSchema);
