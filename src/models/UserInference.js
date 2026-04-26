const mongoose = require('mongoose');

/**
 * UserInference — BUG-8 Phase 9
 *
 * One row per (user, inferenceKey). Stores any inference the system has
 * made about the user that's worth surfacing for transparency. The user
 * can confirm or dismiss each one. Dismissed inferences are suppressed
 * from future personalisation.
 *
 * Inferences come from many sources:
 *   - cognitive traits (time-of-day, modality, session rhythm)
 *   - weakTopics on the goal path
 *   - recurring misconceptions
 *   - any future inferred preference
 *
 * The `key` is stable so the same inference doesn't get re-presented as
 * a new one every time. e.g. `cognitive:time_of_day` rather than the
 * full body of the trait.
 */

const userInferenceSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  key:          { type: String, required: true },             // stable identifier
  kind:         { type: String, required: true },             // 'cognitive_trait' | 'goal_blocker' | 'misconception' | other
  title:        { type: String, required: true },             // user-facing label
  description:  { type: String, required: true },             // 1-sentence human description
  payload:      { type: mongoose.Schema.Types.Mixed },        // structured data for the inference

  status:       {
    type: String,
    enum: ['pending', 'confirmed', 'dismissed'],
    default: 'pending',
  },
  resolvedAt:   { type: Date },                               // when the user confirmed/dismissed
  firstSurfacedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Unique per (user, key) so we update rather than duplicate
userInferenceSchema.index({ userId: 1, key: 1 }, { unique: true });
userInferenceSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('UserInference', userInferenceSchema);
