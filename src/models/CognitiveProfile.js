const mongoose = require('mongoose');

/**
 * CognitiveProfile — BUG-8 Phase 6
 *
 * Per-user behavioural inferences computed from existing data
 * (QuizAttempt timestamps + scores + ContentProgress + content type).
 *
 * Each inferred field carries a `confidence` (0..1) derived from sample
 * size. The Insights layer only surfaces a field when confidence >= 0.6
 * — preventing the system from confidently telling someone "you learn
 * best at 9pm" based on three data points.
 *
 * Computed on-demand by cognitiveFingerprintService.compute(userId)
 * with a 24-hour cache. NOT updated on every quiz attempt — that would
 * be wasted work because the inference smooths slowly.
 */

const cognitiveProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

  // Time-of-day performance — when the user actually scores best
  timeOfDay: {
    bestHour:        { type: Number },          // 0–23
    bestHourBlock:   { type: String },          // 'morning' | 'afternoon' | 'evening' | 'night'
    bestHourScoreLift: { type: Number },        // pp above their average
    confidence:      { type: Number, default: 0 },
    sampleSize:      { type: Number, default: 0 },
  },

  // Modality preference — videos vs notes/articles based on completion rate
  modality: {
    preferred:       { type: String, enum: [null, 'video', 'notes', 'article'], default: null },
    secondPreferred: { type: String, enum: [null, 'video', 'notes', 'article'], default: null },
    completionRates: {
      video: { type: Number, default: 0 },   // 0..1
      notes: { type: Number, default: 0 },
      article: { type: Number, default: 0 },
    },
    confidence:      { type: Number, default: 0 },
    sampleSize:      { type: Number, default: 0 },
  },

  // Session rhythm — short bursts vs deep sessions
  sessionRhythm: {
    style:           { type: String, enum: [null, 'short_bursts', 'medium', 'deep_focus'], default: null },
    medianSessionMinutes: { type: Number, default: 0 },
    typicalSessionsPerDay: { type: Number, default: 0 },
    confidence:      { type: Number, default: 0 },
    sampleSize:      { type: Number, default: 0 },
  },

  computedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('CognitiveProfile', cognitiveProfileSchema);
