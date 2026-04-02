const mongoose = require('mongoose');

const noteRequestSchema = new mongoose.Schema({
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 2000 },
  domain: { type: String, required: true, lowercase: true, trim: true },
  topics: [{ type: String, lowercase: true, trim: true }],
  difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced'] },
  collegeName: { type: String },

  status: { type: String, enum: ['open', 'in_progress', 'fulfilled', 'closed'], default: 'open' },
  fulfilledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  fulfilledContentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
  fulfilledAt: { type: Date },

  upvoteCount: { type: Number, default: 0 },
  responseCount: { type: Number, default: 0 },
}, { timestamps: true });

noteRequestSchema.index({ status: 1, createdAt: -1 });
noteRequestSchema.index({ domain: 1, status: 1 });
noteRequestSchema.index({ requestedBy: 1 });

module.exports = mongoose.model('NoteRequest', noteRequestSchema);
