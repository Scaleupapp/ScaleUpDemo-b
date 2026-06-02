'use strict';
const mongoose = require('mongoose');

/** A self-reported real-world outcome for an objective, with the frozen readiness
 *  context Phase 4B calibrates against. PENDING records are re-askable. */
const ObjectiveOutcomeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', required: true, index: true },
    objectiveType: { type: String },
    label: { type: String, enum: ['SUCCESS', 'PARTIAL', 'NOT_SUCCESS', 'PENDING', 'ABANDONED'], required: true },
    rawChoice: { type: String },
    detail: { type: mongoose.Schema.Types.Mixed },
    source: { type: String, enum: ['target_date_prompt', 'i_got_it', 'objective_close', 'reprompt'] },
    context: {
      readinessAtCapture: Number,
      targetAtCapture: Number,
      bandAtCapture: String,
      readinessAtTarget: Number,
      peakReadiness: Number,
      wasEverReady: Boolean,
      coverageAtCapture: Number,
      weeksToOutcome: Number,
    },
    testimonial: { type: String },
    allowTestimonialUse: { type: Boolean, default: false },
    resolved: { type: Boolean, default: true },
    respondedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
ObjectiveOutcomeSchema.index({ userId: 1, objectiveId: 1 });

module.exports = mongoose.model('ObjectiveOutcome', ObjectiveOutcomeSchema);
