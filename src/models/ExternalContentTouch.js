const mongoose = require('mongoose');

const externalContentTouchSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  taskId: { type: mongoose.Schema.Types.ObjectId, required: true },
  url: { type: String, required: true },
  title: { type: String, default: '' },
  source: { type: String, default: '' },
  topicCanonicalName: { type: String, required: true, index: true },
  selfRating: { type: Number, min: 1, max: 5, required: true },
  completedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

externalContentTouchSchema.index({ userId: 1, topicCanonicalName: 1 });
externalContentTouchSchema.index({ userId: 1, completedAt: -1 });

module.exports = mongoose.model('ExternalContentTouch', externalContentTouchSchema);
