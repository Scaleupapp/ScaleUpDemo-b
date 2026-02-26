const mongoose = require('mongoose');

const youtubeImportSchema = new mongoose.Schema({
  // --- Import config ---
  importedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sourceType: { type: String, enum: ['channel', 'playlist', 'video', 'search'], required: true },
  sourceId: { type: String, required: true },
  sourceName: { type: String },

  // --- Domain mapping ---
  domain: { type: String, lowercase: true, required: true },
  defaultTopics: [{ type: String, lowercase: true }],

  // --- Results ---
  videosFound: { type: Number, default: 0 },
  videosImported: { type: Number, default: 0 },
  videosFailed: { type: Number, default: 0 },
  videosSkipped: { type: Number, default: 0 },

  importedContentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Content' }],

  errors: [{
    videoId: String,
    error: String,
    timestamp: { type: Date, default: Date.now },
  }],

  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'failed', 'partial'],
    default: 'pending',
  },

  startedAt: { type: Date },
  completedAt: { type: Date },
}, { timestamps: true });

youtubeImportSchema.index({ importedBy: 1, createdAt: -1 });
youtubeImportSchema.index({ status: 1 });

module.exports = mongoose.model('YouTubeImport', youtubeImportSchema);
