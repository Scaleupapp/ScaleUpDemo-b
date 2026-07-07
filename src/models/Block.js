const mongoose = require('mongoose');

// A user-to-user block. The blocker no longer sees the blocked user's content
// (feeds, comments, profiles, note-requests) and vice-versa.
const blockSchema = new mongoose.Schema({
  blockerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  blockedId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
}, { timestamps: true });

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

module.exports = mongoose.model('Block', blockSchema);
