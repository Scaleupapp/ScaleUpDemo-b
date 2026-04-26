const mongoose = require('mongoose');

/**
 * ProgressInsightSnapshot — BUG-8 Phase 3
 *
 * Stores a point-in-time record of the cards the Insights service generated
 * for a user. Phase 3 reads the most recent snapshot to do two things:
 *
 *   1. Follow-through detection: did the user act on the suggestion in the
 *      previous snapshot? If they did and their score moved, the next
 *      response prepends a celebration card.
 *
 *   2. Repeat suppression: if the same suggestion appeared last time AND the
 *      user did not act on it, the next response swaps to a different
 *      candidate so we don't robotically repeat ourselves.
 *
 * One snapshot per user is persisted at most once per hour (more than that
 * is mostly noise — the underlying KnowledgeProfile doesn't change that
 * fast in practice).
 */

const cardSnapshotSchema = new mongoose.Schema({
  id:              { type: String, required: true },
  kind:            { type: String, required: true },
  tone:            { type: String, required: true },
  title:           { type: String, required: true },
  body:            { type: String, required: true },
  // The topic this card was nudging the user toward, when applicable.
  // Set for attention/momentum/follow_through cards; null for objective
  // and recent-activity cards which aren't tied to a single topic.
  suggestedTopic:    { type: String, default: null },
  // What kind of nudge it was — used by the next snapshot to decide
  // what counts as "acting on it".
  suggestionType:    {
    type: String,
    enum: [
      null,
      'practice_stale',         // we said: this topic is stale, refresh it
      'address_drop',           // we said: your score on this dropped, fix it
      'practice_blocker',       // we said: this is on your goal path, untouched
      'maintain_momentum',      // we said: your momentum here is great, keep going
      'follow_through_positive',// celebration of prior follow-through
      'follow_through_steady',  // neutral note for prior follow-through
    ],
    default: null,
  },
  // Score on the suggested topic at the moment the snapshot was made.
  // Used by the next snapshot to compute "did the score move?"
  topicScoreAtSuggestion: { type: Number, default: null },
}, { _id: false });

const progressInsightSnapshotSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  generatedAt:   { type: Date, required: true, default: Date.now },
  state:         { type: String, enum: ['cold_start', 'idle', 'active'], required: true },
  narrativeMode: { type: String, enum: ['llm', 'template'], default: 'template' },

  cards: [cardSnapshotSchema],

  // Compact signals digest used by the LLM narrative layer; persisted so a
  // future analyst (or future ML training run) can replay what the system
  // saw at this point in time.
  signalsDigest: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
}, { timestamps: true });

// Lookups always go (userId, generatedAt desc).
progressInsightSnapshotSchema.index({ userId: 1, generatedAt: -1 });

module.exports = mongoose.model('ProgressInsightSnapshot', progressInsightSnapshotSchema);
