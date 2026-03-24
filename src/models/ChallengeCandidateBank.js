const mongoose = require('mongoose');

const candidateBankSchema = new mongoose.Schema({
  topic: { type: String, required: true },
  weekOf: { type: Date, required: true },
  candidates: [{
    questionText: { type: String, required: true },
    questionType: { type: String, enum: ['recall', 'application', 'conceptual', 'critical_thinking'] },
    options: [{ label: { type: String }, text: { type: String } }],
    correctAnswer: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
    explanation: { type: String },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
    concept: { type: String },
    assignedTo: { type: String, enum: ['daily', 'live'], default: null },
    assignedDate: { type: Date },
  }],
  status: { type: String, enum: ['pending_review', 'curated', 'used'], default: 'pending_review' },
  generatedAt: { type: Date, default: Date.now },
  curatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  curatedAt: { type: Date },
}, { timestamps: true });

candidateBankSchema.index({ topic: 1, weekOf: 1 });

module.exports = mongoose.model('ChallengeCandidateBank', candidateBankSchema);
