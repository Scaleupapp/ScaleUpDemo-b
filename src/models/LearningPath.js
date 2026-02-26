const mongoose = require('mongoose');

const learningPathItemSchema = new mongoose.Schema({
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  order: { type: Number, required: true },
  note: { type: String, maxlength: 500 },
  isOptional: { type: Boolean, default: false },
}, { _id: false });

const learningPathSchema = new mongoose.Schema({
  // --- Owner ---
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  creatorType: { type: String, enum: ['creator', 'consumer'], required: true },

  // --- Meta ---
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 2000 },
  domain: { type: String, lowercase: true, trim: true },
  topics: [{ type: String, lowercase: true, trim: true }],
  difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced', 'mixed'], default: 'mixed' },
  estimatedHours: { type: Number },

  // --- Objective alignment ---
  targetObjectiveType: {
    type: String,
    enum: [
      'exam_preparation', 'upskilling', 'interview_preparation',
      'networking', 'career_switch', 'academic_excellence', 'casual_learning',
    ],
  },
  targetSpecifics: { type: String },

  // --- Items (content from any creator) ---
  items: [learningPathItemSchema],
  totalItems: { type: Number, default: 0 },

  // --- Status ---
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
  isPublic: { type: Boolean, default: true },
  publishedAt: { type: Date },

  // --- Engagement ---
  followerCount: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0 },
  ratingCount: { type: Number, default: 0 },
  completionCount: { type: Number, default: 0 },
}, { timestamps: true });

learningPathSchema.index({ createdBy: 1, status: 1 });
learningPathSchema.index({ domain: 1, status: 1, followerCount: -1 });
learningPathSchema.index({ topics: 1, status: 1 });
learningPathSchema.index({ targetObjectiveType: 1, status: 1 });

module.exports = mongoose.model('LearningPath', learningPathSchema);
