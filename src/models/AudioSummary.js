const mongoose = require('mongoose');

const audioSummarySchema = new mongoose.Schema({
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  s3Key: { type: String, required: true },
  duration: { type: Number },
  voice: { type: String, default: 'alloy' },
  status: { type: String, enum: ['generating', 'ready', 'failed'], default: 'generating' },
  generatedAt: { type: Date },
  fileSize: { type: Number },
}, { timestamps: true });

audioSummarySchema.index({ contentId: 1 }, { unique: true });

module.exports = mongoose.model('AudioSummary', audioSummarySchema);
