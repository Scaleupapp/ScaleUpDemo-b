const mongoose = require('mongoose');

const consumptionGraphSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  topicNodes: [{
    topic: { type: String, lowercase: true },
    contentConsumed: { type: Number, default: 0 },
    totalTimeSpent: { type: Number, default: 0 },
    lastConsumedAt: { type: Date },
    affinityScore: { type: Number, default: 0 },
    contentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Content' }],
  }],

  topicEdges: [{
    topicA: { type: String, lowercase: true },
    topicB: { type: String, lowercase: true },
    strength: { type: Number, default: 0 },
  }],

  totalContentConsumed: { type: Number, default: 0 },
  totalTimeSpent: { type: Number, default: 0 },
  dominantTopics: [String],
  lastUpdatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

consumptionGraphSchema.index({ userId: 1 });

module.exports = mongoose.model('ConsumptionGraph', consumptionGraphSchema);
