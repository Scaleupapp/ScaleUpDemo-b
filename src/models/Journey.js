const mongoose = require('mongoose');

const dailyAssignmentSchema = new mongoose.Schema({
  day: { type: Number, min: 1, max: 7 },
  contentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Content' }],
  topics: [String],
  estimatedTime: { type: Number },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date },
}, { _id: false });

const weeklyPlanSchema = new mongoose.Schema({
  weekNumber: { type: Number },
  startDate: { type: Date },
  endDate: { type: Date },
  phaseIndex: { type: Number },
  status: { type: String, enum: ['upcoming', 'active', 'completed'], default: 'upcoming' },
  dailyAssignments: [dailyAssignmentSchema],
  scheduledQuiz: {
    dayOfWeek: Number,
    type: { type: String },
    topics: [String],
    quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' },
    completed: { type: Boolean, default: false },
  },
  goals: [String],
  outcomes: [String],
}, { _id: true });

const milestoneSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: {
    type: String,
    enum: ['topic_completion', 'score_target', 'streak', 'phase_completion', 'project', 'final_assessment'],
  },
  targetCriteria: {
    targetScore: Number,
    targetTopic: String,
    streakDays: Number,
  },
  scheduledDate: { type: Date },
  status: {
    type: String,
    enum: ['upcoming', 'in_progress', 'completed', 'overdue', 'skipped'],
    default: 'upcoming',
  },
  completedAt: { type: Date },
  result: { type: mongoose.Schema.Types.Mixed },
}, { _id: true });

const journeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', required: true },

  title: { type: String, required: true },
  status: { type: String, enum: ['generating', 'active', 'paused', 'completed', 'abandoned'], default: 'generating' },

  pausedDuration: {
    type: Number,
    default: 0,
    min: 0
  }, // Total ms spent paused (accumulated across pause/resume cycles)
  pausedAt: {
    type: Date,
    default: null
  }, // When journey was last paused (null if active)
  lastResumedAt: {
    type: Date,
    default: null
  }, // When journey was last resumed

  phases: [{
    name: { type: String, required: true },
    type: { type: String, enum: ['foundation', 'building', 'strengthening', 'mastery', 'revision', 'exam_prep'] },
    order: { type: Number },
    durationDays: { type: Number },
    startDate: { type: Date },
    endDate: { type: Date },
    status: { type: String, enum: ['upcoming', 'active', 'completed', 'skipped'], default: 'upcoming' },
    objectives: [String],
    focusTopics: [String],
  }],
  currentPhaseIndex: { type: Number, default: 0 },

  weeklyPlans: [weeklyPlanSchema],
  currentWeek: { type: Number, default: 1 },

  milestones: [milestoneSchema],

  adaptationHistory: [{
    date: { type: Date, default: Date.now },
    trigger: String,
    changes: String,
    details: mongoose.Schema.Types.Mixed,
  }],

  progress: {
    overallPercentage: { type: Number, default: 0 },
    contentConsumed: { type: Number, default: 0 },
    contentAssigned: { type: Number, default: 0 },
    quizzesCompleted: { type: Number, default: 0 },
    quizzesAssigned: { type: Number, default: 0 },
    milestonesCompleted: { type: Number, default: 0 },
    milestonesTotal: { type: Number, default: 0 },
    currentStreak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
  },

  aiModel: { type: String, default: 'gpt-4o' },
  generatedAt: { type: Date },
}, { timestamps: true });

journeySchema.index({ userId: 1, status: 1 });
journeySchema.index({ userId: 1, objectiveId: 1 });

module.exports = mongoose.model('Journey', journeySchema);
