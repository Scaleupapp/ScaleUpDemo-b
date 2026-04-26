const mongoose = require('mongoose');

/**
 * MisconceptionLedger — BUG-8 Phase 4
 *
 * One document per user. Tracks distractor-tagged misconceptions every
 * time the user picks a wrong option that carries a `misconception.tag`.
 * Powers the "you keep making the same mistake" insight signal.
 *
 * Each entry is keyed by tag (snake_case, stable across questions). When
 * the same misconception fires across multiple topics, that's a strong
 * signal of a transferable confusion the user should be told about.
 */

const ledgerEntrySchema = new mongoose.Schema({
  tag:                { type: String, required: true },
  count:              { type: Number, default: 0 },
  firstSeenAt:        { type: Date },
  lastSeenAt:         { type: Date },
  topicsAffected:     [{ type: String }],
  recentExplanation:  { type: String }, // most recent human-readable phrasing
  recentTopic:        { type: String }, // topic where it last fired
}, { _id: false });

const misconceptionLedgerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  entries: [ledgerEntrySchema],
  totalMisconceptionsTracked: { type: Number, default: 0 },
  lastUpdatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('MisconceptionLedger', misconceptionLedgerSchema);
