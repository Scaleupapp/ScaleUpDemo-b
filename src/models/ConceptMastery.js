const mongoose = require('mongoose');

/**
 * ConceptMastery — BUG-8 Phase 5
 *
 * Per-user, per-concept memory state for spaced repetition.
 * Uses a simplified FSRS (Free Spaced Repetition Scheduler) model:
 *   stability  — days the memory will hold above ~90% recall
 *   difficulty — how hard this concept is for THIS user (1.0 easy → 10.0 hard)
 *   reps       — successful recalls in a row (resets on lapse)
 *   lapses     — total number of failures
 *   nextReviewAt — when the system thinks the user should see this again
 *
 * The scheduler logic lives in spacedRepetitionService.js. This model is
 * just storage.
 */

const conceptMasterySchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  concept:      { type: String, required: true, lowercase: true, index: true },
  topic:        { type: String, lowercase: true }, // best-effort parent topic for grouping

  // FSRS state
  stability:    { type: Number, default: 1.0 },    // days
  difficulty:   { type: Number, default: 5.0 },    // 1.0–10.0
  reps:         { type: Number, default: 0 },
  lapses:       { type: Number, default: 0 },

  // Schedule
  lastReviewedAt: { type: Date },
  nextReviewAt:   { type: Date, index: true },

  // Last quality of recall (0=lapse, 1=hard, 2=good, 3=easy) — used by FSRS
  lastQuality:    { type: Number, min: 0, max: 3 },
}, { timestamps: true });

// Compound index for the "what's due now for this user" query
conceptMasterySchema.index({ userId: 1, nextReviewAt: 1 });
// Uniqueness — at most one mastery row per (user, concept)
conceptMasterySchema.index({ userId: 1, concept: 1 }, { unique: true });

module.exports = mongoose.model('ConceptMastery', conceptMasterySchema);
