const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  questionText: { type: String, required: true },
  questionType: {
    type: String,
    enum: ['conceptual', 'application', 'cross_content', 'recall', 'critical_thinking'],
    default: 'conceptual',
  },
  options: [{
    label: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
    text: { type: String, required: true },
  }],
  correctAnswer: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  explanation: { type: String },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  sourceContentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
  sourceTimestamp: { type: String },
  concept: { type: String },
}, { _id: true });

const quizSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  title: { type: String, required: true },
  type: {
    type: String,
    enum: [
      'topic_consolidation', 'weekly_review', 'milestone_assessment',
      'retention_check', 'on_demand', 'playlist_mastery',
    ],
    required: true,
  },

  topic: { type: String, lowercase: true },
  sourceContentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Content' }],
  objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective' },

  questions: [questionSchema],
  totalQuestions: { type: Number, required: true },
  timePerQuestion: { type: Number, default: 60 },

  status: {
    type: String,
    enum: ['generating', 'ready', 'delivered', 'in_progress', 'completed', 'expired'],
    default: 'generating',
  },
  deliveredAt: { type: Date },
  expiresAt: { type: Date },
  aiModel: { type: String, default: 'gpt-4o' },
  generatedAt: { type: Date },
}, { timestamps: true });

quizSchema.index({ userId: 1, status: 1, createdAt: -1 });
quizSchema.index({ userId: 1, topic: 1 });
quizSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('Quiz', quizSchema);
