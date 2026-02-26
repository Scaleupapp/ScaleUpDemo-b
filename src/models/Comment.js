const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment' },
  text: { type: String, required: true, maxlength: 1000 },
  likeCount: { type: Number, default: 0 },
  isEdited: { type: Boolean, default: false },
  deletedAt: { type: Date },
}, { timestamps: true });

commentSchema.index({ contentId: 1, createdAt: -1 });
commentSchema.index({ parentId: 1 });

module.exports = mongoose.model('Comment', commentSchema);
