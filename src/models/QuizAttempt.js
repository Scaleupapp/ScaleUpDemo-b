const mongoose = require('mongoose');

const quizAttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', required: true },

  answers: [{
    questionIndex: { type: Number, required: true },
    selectedAnswer: { type: String, enum: ['A', 'B', 'C', 'D', 'skipped'] },
    isCorrect: { type: Boolean },
    timeTaken: { type: Number },
    textResponse: { type: String },        // Optional free-text answer
    competency: { type: String },          // Which competency this tests
    textEvaluation: {                      // Claude's evaluation of text response
      score: Number,                       // 0-100
      feedback: String,
      partialCredit: Boolean,
    },
  }],

  score: {
    total: Number,
    correct: Number,
    incorrect: Number,
    skipped: Number,
    percentage: Number,
  },

  topicBreakdown: [{
    topic: String,
    correct: Number,
    total: Number,
    percentage: Number,
  }],

  analysis: {
    strengths: [String],
    weaknesses: [String],
    missedConcepts: [{
      concept: String,
      contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
      timestamp: String,
      suggestion: String,
    }],
    confidenceScore: Number,
    comparisonToPrevious: {
      previousScore: Number,
      improvement: Number,
      trend: { type: String, enum: ['improving', 'stable', 'declining'] },
    },
  },

  // Competency-level breakdown (from Claude evaluation)
  competencyBreakdown: [{
    competency: String,
    correct: Number,
    total: Number,
    percentage: Number,
    textScoreAvg: Number,
    level: String,
  }],

  startedAt: Date,
  completedAt: Date,
  totalTime: Number,
  status: { type: String, enum: ['in_progress', 'completed', 'abandoned'], default: 'in_progress' },
}, { timestamps: true });

quizAttemptSchema.index({ userId: 1, quizId: 1 });
quizAttemptSchema.index({ userId: 1, completedAt: -1 });

module.exports = mongoose.model('QuizAttempt', quizAttemptSchema);
