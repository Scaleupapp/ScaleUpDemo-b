const mongoose = require('mongoose');

const allocationSchema = new mongoose.Schema({
  topicCanonicalName: { type: String, required: true },
  hours: { type: Number, required: true, min: 0 },
  focusActivity: { type: String, required: true },
}, { _id: false });

const taskTopicSchema = new mongoose.Schema({
  canonicalName: { type: String, required: true },
  displayName: { type: String, required: true },
}, { _id: false });

const taskCompletionSchema = new mongoose.Schema({
  mode: { type: String, enum: ['auto', 'manual'], required: true },
  requiresSelfRating: { type: Boolean, default: false },
}, { _id: false });

const taskProgressSchema = new mongoose.Schema({
  status: { type: String, enum: ['pending', 'in_progress', 'complete', 'skipped'], default: 'pending' },
  completedAt: { type: Date, default: null },
  selfRating: { type: Number, min: 1, max: 5, default: null },
  sourceEventId: { type: String, default: null },
}, { _id: false });

const taskSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['quiz', 'in_app_content', 'ai_interview', 'external_link', 'competition', 'manual'],
    required: true,
  },
  topic: { type: taskTopicSchema, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  completion: { type: taskCompletionSchema, required: true },
  progress: { type: taskProgressSchema, default: () => ({ status: 'pending' }) },
  generatedAt: { type: Date, default: Date.now },
}, { _id: true });

const weeklyEntrySchema = new mongoose.Schema({
  week: { type: Number, required: true, min: 1 },
  weeklyGoal: { type: String, required: true },
  allocations: { type: [allocationSchema], default: [] },
  tasks: { type: [taskSchema], default: [] },
}, { _id: false });

const milestoneSchema = new mongoose.Schema({
  week: { type: Number, required: true, min: 1 },
  title: { type: String, required: true },
  measurableCriteria: { type: String, required: true },
  isUserStated: { type: Boolean, default: false },
}, { _id: false });

const planSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', required: true },
  diagnosticAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiagnosticAttempt', required: true },
  planHeadline: { type: String, required: true },
  estimatedTotalHours: { type: Number, required: true, min: 0 },
  bufferRecommendation: { type: String, default: '' },
  weeklySchedule: { type: [weeklyEntrySchema], default: [] },
  milestones: { type: [milestoneSchema], default: [] },
  source: {
    type: String,
    enum: ['llm-generated', 'template', 'rebalanced'],
    required: true,
  },
  llmLatencyMs: { type: Number, default: null },
  llmModel: { type: String, default: null },
  supersededAt: { type: Date, default: null },
  supersededByPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

planSchema.index({ userId: 1, isActive: 1 });
planSchema.index({ diagnosticAttemptId: 1 });

module.exports = mongoose.model('Plan', planSchema);
