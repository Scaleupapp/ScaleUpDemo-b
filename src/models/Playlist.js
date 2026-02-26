const mongoose = require('mongoose');

const playlistSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, maxlength: 100 },
  description: { type: String, maxlength: 500 },
  items: [{
    contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
    order: { type: Number },
    addedAt: { type: Date, default: Date.now },
  }],
  isPublic: { type: Boolean, default: false },
  itemCount: { type: Number, default: 0 },
  totalDuration: { type: Number, default: 0 },
}, { timestamps: true });

playlistSchema.index({ userId: 1 });

module.exports = mongoose.model('Playlist', playlistSchema);
