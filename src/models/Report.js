const mongoose = require('mongoose');

// Generic user report for objectionable user-generated content or abusive
// users. Complements the content-specific ContentReport (which keeps the
// existing content moderation queue). Used for comments, note-requests and
// users, and surfaced to admins.
const reportSchema = new mongoose.Schema({
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetType: { type: String, enum: ['comment', 'user', 'noteRequest', 'content'], required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // The author of the reported item (so admins can act on the user directly).
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reason: {
    type: String,
    enum: ['inappropriate', 'spam', 'harassment', 'hate_speech', 'misleading', 'copyright', 'other'],
    required: true,
  },
  description: { type: String, maxlength: 1000 },
  status: { type: String, enum: ['pending', 'reviewed', 'actioned', 'dismissed'], default: 'pending' },
}, { timestamps: true });

// One report per user per target.
reportSchema.index({ reporterId: 1, targetType: 1, targetId: 1 }, { unique: true });
reportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Report', reportSchema);
