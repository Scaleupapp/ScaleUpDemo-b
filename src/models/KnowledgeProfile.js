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
    scoreHistory: [{
      score: Number,
      date: Date,
      quizId: mongoose.Schema.Types.ObjectId,
      objectiveId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'UserObjective',
        default: null
      }
    }],
    trend: { type: String, enum: ['improving', 'stable', 'declining'], default: 'stable' },
    objectiveId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'UserObjective',
      default: null
    }, // null = legacy/global entry, set = objective-specific
    targetDifficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard'],
      default: 'medium',
    },

    // Day-1 Diagnostic additions (additive, optional). Captured at the
    // proficiency check; downstream services use them for calibration-
    // aware framing in Insights cards.
    selfRating: {
      type: String,
      enum: ['novice', 'familiar', 'proficient', 'expert', 'unsure'],
      default: undefined,
    },
    calibrationAtBaseline: {
      delta:      { type: Number, default: null }, // -3..+3 (positive = over-confident)
      capturedAt: { type: Date },
    },
  }],

  // Phase 6: per-topic interview mastery, keyed by canonical (kebab-case) topic name.
  // Updated by planProgressService.onInterviewComplete from perQuestion eval scores.
  // Read by interviewService.startInterview to bias question selection toward weak topics.
  topicInterviewMastery: {
    type: Map,
    of: new mongoose.Schema({
      score: { type: Number, default: 0 },         // running average 0..10
      sessions: { type: Number, default: 0 },
      lastScoredAt: { type: Date },
      trend: { type: String, enum: ['improving', 'stable', 'declining'], default: 'stable' },
      scoreHistory: [{
        score: Number,
        sessionId: mongoose.Schema.Types.ObjectId,
        scoredAt: Date,
      }],
    }, { _id: false }),
    default: () => new Map(),
  },

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
