const mongoose = require('mongoose');

const contentInteractionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  type: { type: String, enum: ['like', 'save', 'rate', 'share', 'comment_like'], required: true },
  value: { type: Number },
}, { timestamps: true });

contentInteractionSchema.index({ userId: 1, contentId: 1, type: 1 }, { unique: true });
contentInteractionSchema.index({ contentId: 1, type: 1 });

module.exports = mongoose.model('ContentInteraction', contentInteractionSchema);
