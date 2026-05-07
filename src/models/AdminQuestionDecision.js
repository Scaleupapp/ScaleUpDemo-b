const mongoose = require('mongoose');

/**
 * AdminQuestionDecision — immutable log of every admin action taken on a
 * DiagnosticQuestionBank document. Each approve/edit/reject produces one record.
 * The validatorScore and validatorCritique fields snapshot the AI assessment at
 * the moment of decision — used by the training signal service (Task 14) to
 * generate few-shot examples for prompt improvement.
 */
const adminQuestionDecisionSchema = new mongoose.Schema({
  questionId:         { type: mongoose.Schema.Types.ObjectId, ref: 'DiagnosticQuestionBank', required: true, index: true },
  adminId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action:             { type: String, enum: ['approve', 'edit', 'reject'], required: true },
  reason:             { type: String },
  editDiff:           { type: mongoose.Schema.Types.Mixed }, // only on action='edit'
  validatorScore:     { type: Number },   // snapshot at decision time
  validatorCritique:  { type: String },   // snapshot at decision time
  regenerate:         { type: Boolean, default: false }, // only meaningful for reject
}, { timestamps: true });

module.exports = mongoose.model('AdminQuestionDecision', adminQuestionDecisionSchema);
