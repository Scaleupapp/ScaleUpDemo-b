const mongoose = require('mongoose');

const allocationSchema = new mongoose.Schema({
  topicCanonicalName: { type: String, required: true },
  hours: { type: Number, required: true, min: 0 },
  focusActivity: { type: String, required: true },
}, { _id: false });

const weeklyEntrySchema = new mongoose.Schema({
  week: { type: Number, required: true, min: 1 },
  weeklyGoal: { type: String, required: true },
  allocations: { type: [allocationSchema], default: [] },
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
