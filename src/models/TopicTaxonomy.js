const mongoose = require('mongoose');

const OBJECTIVE_TYPES = [
  'upskilling',
  'interview_preparation',
  'exam_preparation',
  'career_switch',
  'academic_excellence',
  'casual_learning',
  'networking',
];

const DIFFICULTIES = ['foundational', 'intermediate', 'advanced'];

const topicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    canonicalName: { type: String, required: true },
    description: { type: String, required: true },
    baseDifficulty: { type: String, enum: DIFFICULTIES, required: true },
    isFutureProofing: { type: Boolean, default: false },
    sortOrder: { type: Number, required: true },
    applicableObjectives: { type: [String], default: undefined },
  },
  { _id: false }
);

const userEditSignalSchema = new mongoose.Schema(
  {
    timesRemoved: { type: Map, of: Number, default: () => new Map() },
    timesAdded: { type: Map, of: Number, default: () => new Map() },
  },
  { _id: false }
);

const topicTaxonomySchema = new mongoose.Schema(
  {
    objectiveType: { type: String, enum: OBJECTIVE_TYPES, required: true },
    targetKey: { type: String, required: true },
    topics: { type: [topicSchema], default: [] },
    source: {
      type: String,
      enum: ['curated', 'llm-generated'],
      required: true,
    },
    lastRefreshedAt: { type: Date, default: Date.now },
    refreshCount: { type: Number, default: 0 },
    userEditSignal: { type: userEditSignalSchema, default: () => ({}) },
  },
  { timestamps: true }
);

topicTaxonomySchema.index({ objectiveType: 1, targetKey: 1 }, { unique: true });

module.exports = mongoose.model('TopicTaxonomy', topicTaxonomySchema);
module.exports.OBJECTIVE_TYPES = OBJECTIVE_TYPES;
module.exports.DIFFICULTIES = DIFFICULTIES;
