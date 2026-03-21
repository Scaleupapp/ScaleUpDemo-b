const mongoose = require('mongoose');

const knowledgeProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  topicMastery: [{
    topic: { type: String, lowercase: true },
    score: { type: Number, default: 0, min: 0, max: 100 },
    level: {
      type: String,
      enum: ['not_started', 'beginner', 'intermediate', 'advanced', 'expert'],
      default: 'not_started',
    },
    quizzesTaken: { type: Number, default: 0 },
    lastAssessedAt: { type: Date },
    scoreHistory: [{ score: Number, date: Date, quizId: mongoose.Schema.Types.ObjectId }],
    trend: { type: String, enum: ['improving', 'stable', 'declining'], default: 'stable' },
  }],

  learningVelocity: {
    topicsPerWeek: { type: Number, default: 0 },
    averageScoreImprovement: { type: Number, default: 0 },
    contentToMasteryRatio: { type: Number, default: 0 },
  },

  retention: {
    averageRetentionRate: { type: Number, default: 0 },
    optimalReviewInterval: { type: Number, default: 7 },
  },

  behavioralProfile: {
    type: { type: String, enum: ['speed_focused', 'accuracy_focused', 'balanced', 'inconsistent'], default: 'balanced' },
    averageAnswerTime: { type: Number, default: 0 },
    peakHours: [Number],
    consistencyScore: { type: Number, default: 0 },
  },

  strengths: [String],
  weaknesses: [String],
  overallScore: { type: Number, default: 0 },
  totalQuizzesTaken: { type: Number, default: 0 },
  totalTopicsCovered: { type: Number, default: 0 },
  lastUpdatedAt: { type: Date, default: Date.now },
  _processedAttempts: [{ type: String }],  // Idempotency: track processed quiz attempt IDs
}, { timestamps: true });

knowledgeProfileSchema.index({ userId: 1 });

module.exports = mongoose.model('KnowledgeProfile', knowledgeProfileSchema);
