const mongoose = require('mongoose');

/**
 * v2 Compass conversation — cross-content, cross-mode persistent thread.
 *
 * One active thread per user (most-recent). New threads start when user
 * explicitly resets or after a long inactivity window. Threads survive
 * across modes (conversation → mentor → coach) so Compass keeps continuity.
 *
 * Differs from the v1 `Conversation` model which is scoped to a specific
 * Content piece (per-video AI Tutor). Both models coexist.
 */
const compassMessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true, maxlength: 8000 },
  mode: { type: String },         // greeting | conversation | quiz_config | insight | mentor | coach | tutor | note
  followups: [String],            // suggested follow-ups for the last assistant turn
  // Rich answer cards projected from invoked Compass tools (Progress Intelligence).
  // Optional + additive — old messages decode unchanged. Mixed payload per type.
  cards: [{
    _id: false,
    type: { type: String },                                  // readiness_explanation | activity_result | topic_detail | weak_topics | recent_activity
    payload: { type: mongoose.Schema.Types.Mixed },
  }],
  // tutor mode — the content piece this turn is scoped to (so history shows
  // "Tutor · <video>" and analytics can attribute tutor usage to content).
  contentRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
  contentTitle: { type: String },
  tokensIn:  { type: Number },    // approx tokens consumed
  tokensOut: { type: Number },
}, { timestamps: true });

const compassConversationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, default: 'New conversation' },
  messages: [compassMessageSchema],
  messageCount: { type: Number, default: 0 },
  lastMessageAt: { type: Date, index: true },
  isArchived: { type: Boolean, default: false },
}, { timestamps: true });

compassConversationSchema.index({ userId: 1, lastMessageAt: -1 });
compassConversationSchema.index({ userId: 1, isArchived: 1, lastMessageAt: -1 });

module.exports = mongoose.model('CompassConversation', compassConversationSchema);
