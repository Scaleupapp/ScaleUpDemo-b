const mongoose = require('mongoose');

const userObjectiveSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // --- What ---
  objectiveType: {
    type: String,
    enum: [
      'exam_preparation', 'upskilling', 'interview_preparation',
      'networking', 'career_switch', 'academic_excellence', 'casual_learning',
    ],
    required: true,
  },
  specifics: {
    examName: { type: String, trim: true },
    targetRole: { type: String, trim: true },
    targetSkill: { type: String, trim: true },
    targetCompany: { type: String, trim: true },
    fromDomain: { type: String, trim: true },
    toDomain: { type: String, trim: true },
  },

  // --- When ---
  timeline: {
    type: String,
    enum: ['1_month', '3_months', '6_months', '1_year', 'no_deadline'],
    required: true,
  },
  targetDate: { type: Date },

  // --- Current State ---
  currentLevel: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced'],
    required: true,
  },

  // --- Commitment ---
  weeklyCommitHours: { type: Number, min: 1, max: 40, required: true },
  preferredLearningStyle: {
    type: String,
    enum: ['videos', 'articles', 'interactive', 'mix'],
    default: 'mix',
  },

  // --- Topics ---
  topicsOfInterest: [{ type: String, lowercase: true, trim: true }],

  // --- Status & Weighting ---
  status: { type: String, enum: ['active', 'paused', 'completed', 'abandoned'], default: 'active' },
  isPrimary: { type: Boolean, default: true },
  weight: { type: Number, default: 100, min: 0, max: 100 },

  completedAt: { type: Date },
  pausedAt: { type: Date },

  // --- AI-Generated Objective Analysis (Claude) ---
  analysis: {
    competencies: [{
      name: { type: String },
      description: String,
      weight: { type: Number, min: 1, max: 10 },
      category: { type: String, enum: ['core', 'advanced', 'soft_skill'] },
      prerequisites: [String],
      assessmentTypes: [String],
      proficiencyLevels: [{
        level: Number,
        title: String,
        description: String,
      }],
    }],
    objectiveBrief: {
      overview: String,
      dayToDay: String,
      challenges: String,
      successCriteria: String,
      industryContext: String,
    },
    contentCoverage: {
      covered: [String],
      gaps: [String],
      gapStrategies: [{
        competency: String,
        strategy: { type: String, enum: ['self_study', 'external', 'practice', 'assessment_only'] },
        resources: [String],
      }],
    },
    assessmentStrategy: {
      recommended: [{
        competency: String,
        assessmentType: String,
        reasoning: String,
      }],
    },
    analyzedAt: Date,
    aiModel: String,
  },
}, { timestamps: true });

userObjectiveSchema.index({ userId: 1, status: 1 });
userObjectiveSchema.index({ userId: 1, isPrimary: 1 });

// Auto-calculate targetDate from timeline
userObjectiveSchema.pre('save', function (next) {
  if (this.isModified('timeline') && this.timeline !== 'no_deadline') {
    const months = { '1_month': 1, '3_months': 3, '6_months': 6, '1_year': 12 };
    const d = new Date();
    d.setMonth(d.getMonth() + months[this.timeline]);
    this.targetDate = d;
  }
  next();
});

module.exports = mongoose.model('UserObjective', userObjectiveSchema);
