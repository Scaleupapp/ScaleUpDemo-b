const mongoose = require('mongoose');

const externalContentSnapshotSchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true, index: true },
  title: { type: String, default: '' },
  excerpt: { type: String, default: '' },          // capped at 8000 chars
  contentType: { type: String, default: 'unknown' }, // article|youtube|pdf|other
  wordCount: { type: Number, default: 0 },
  fetchedAt: { type: Date, default: Date.now },
  fetchError: { type: String, default: null },
}, { timestamps: true });

// TTL: re-fetch after 30 days (Mongo auto-deletes old snapshots)
externalContentSnapshotSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('ExternalContentSnapshot', externalContentSnapshotSchema);
