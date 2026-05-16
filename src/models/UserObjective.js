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
  specificsCanonical: {
    examName: { type: String, trim: true },
    targetSkill: { type: String, trim: true },
    targetRole: { type: String, trim: true },
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
  topicSelfRatings: {
    type: Map,
    of: {
      type: String,
      enum: ['novice', 'familiar', 'proficient', 'expert'],
    },
    default: () => new Map(),
  },
  needsCalibration: { type: Boolean, default: false, index: true },

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

  // Canonical cohort key — resolved by topicCanonicalizationService from
  // (specifics, objectiveType). Used as the (DailyChallenge.topic) value
  // and the CohortDirectory.canonicalTopic key. Lowercase, indexed.
  canonicalTopic: { type: String, lowercase: true, index: true },
  canonicalTopic_needsReview: { type: Boolean, default: false },
  canonicalTopic_lastResolvedAt: { type: Date },
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

/**
 * Resolve canonicalTopic whenever objectiveType or specifics changes.
 * Failure is non-fatal — the canonicalizer's own fallback ensures we
 * always have a string to store.
 */
userObjectiveSchema.pre('save', async function preResolveCanonicalTopic(next) {
  try {
    if (!this.isModified('objectiveType') && !this.isModified('specifics') && this.canonicalTopic) {
      return next();
    }
    const topicCanonicalizationService = require('../services/topicCanonicalizationService');
    const cohortDirectoryService = require('../services/cohortDirectoryService');

    const derivedRaw =
      this.specifics?.targetRole ||
      this.specifics?.examName ||
      this.specifics?.targetSkill ||
      this.specifics?.toDomain ||
      (this.topicsOfInterest && this.topicsOfInterest[0]) ||
      this.objectiveType;

    const oldCanonical = this.canonicalTopic;
    const result = await topicCanonicalizationService.canonicalize(derivedRaw, this.objectiveType);
    this.canonicalTopic = result.canonicalTopic;
    this.canonicalTopic_needsReview = result.source === 'fallback';
    this.canonicalTopic_lastResolvedAt = new Date();

    // Directory bookkeeping — only when the canonical topic actually changes
    // and only for primary+active objectives (they're the cohort-eligible ones).
    if (this.status === 'active' && this.isPrimary && this.canonicalTopic !== oldCanonical) {
      if (oldCanonical) {
        await cohortDirectoryService.recordMemberLeave(oldCanonical).catch(() => null);
      }
      await cohortDirectoryService.recordMemberJoin(this.canonicalTopic, this.objectiveType).catch(() => null);
    }
    return next();
  } catch (err) {
    // Non-fatal: log and proceed. The lazy backfill or housekeeping job
    // will pick this up on the next read.
    console.warn('[UserObjective.preSave] canonicalize failed:', err.message);
    this.canonicalTopic_needsReview = true;
    return next();
  }
});

module.exports = mongoose.model('UserObjective', userObjectiveSchema);
