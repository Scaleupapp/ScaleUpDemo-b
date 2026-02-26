const mongoose = require('mongoose');

const quizTriggerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  triggerType: {
    type: String,
    enum: ['topic_threshold', 'weekly_checkpoint', 'playlist_completed',
           'plan_milestone', 'retention_check', 'on_demand'],
    required: true,
  },
  topic: { type: String, lowercase: true },
  sourceContentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Content' }],
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' },
  status: {
    type: String,
    enum: ['pending', 'queued', 'triggered', 'generating', 'generated', 'delivered', 'completed', 'expired', 'failed'],
    default: 'pending',
  },
}, { timestamps: true });

quizTriggerSchema.index({ userId: 1, status: 1 });
quizTriggerSchema.index({ userId: 1, topic: 1, createdAt: -1 });

module.exports = mongoose.model('QuizTrigger', quizTriggerSchema);
