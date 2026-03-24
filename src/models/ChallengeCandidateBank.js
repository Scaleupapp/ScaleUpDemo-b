const mongoose = require('mongoose');

const candidateBankSchema = new mongoose.Schema({
  topic: { type: String, required: true },
  weekOf: { type: Date, required: true },
  candidates: [{
    questionText: String,
    questionType: { type: String, enum: ['recall', 'application', 'conceptual', 'critical_thinking'] },
    options: [{ label: String, text: String }],
    correctAnswer: { type: String, enum: ['A', 'B', 'C', 'D'] },
    explanation: String,
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
    concept: String,
    assignedTo: { type: String, enum: ['daily', 'live', null], default: null },
    assignedDate: { type: Date },
  }],
  status: { type: String, enum: ['pending_review', 'curated', 'used'], default: 'pending_review' },
  generatedAt: { type: Date, default: Date.now },
  curatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  curatedAt: { type: Date },
}, { timestamps: true });

candidateBankSchema.index({ topic: 1, weekOf: 1 });

module.exports = mongoose.model('ChallengeCandidateBank', candidateBankSchema);
