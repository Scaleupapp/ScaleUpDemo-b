const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true, maxlength: 5000 },
  // For assistant messages — track which transcript segment was used for context
  contextMeta: {
    timestampRange: { type: String },        // e.g. "4:12–5:30"
    conceptsReferenced: [String],            // keyConcept names used
    tutorTier: { type: String, enum: ['full', 'limited'] },
  },
}, { timestamps: true });

const conversationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  messages: [messageSchema],
  messageCount: { type: Number, default: 0 },

  // Quick access to content context (denormalized for performance)
  contentTitle: { type: String },
  contentDomain: { type: String },

  // Tutor capability tier for this conversation
  tutorTier: { type: String, enum: ['full', 'limited'], default: 'full' },

  lastMessageAt: { type: Date },
}, { timestamps: true });

// One active conversation per user per content
conversationSchema.index({ userId: 1, contentId: 1 }, { unique: true });
conversationSchema.index({ userId: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
