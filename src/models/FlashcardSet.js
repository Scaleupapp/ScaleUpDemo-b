const mongoose = require('mongoose');

const cardSchema = new mongoose.Schema({
  front: { type: String, required: true },
  back: { type: String, required: true },
  hint: { type: String },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  concept: { type: String },
}, { _id: true });

const flashcardSetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  title: { type: String, required: true },
  cards: [cardSchema],
  totalCards: { type: Number, required: true },
  status: { type: String, enum: ['generating', 'ready', 'failed'], default: 'generating' },
  generatedAt: { type: Date },
  aiModel: { type: String, default: 'gpt-4o' },

  // Study progress
  lastStudiedAt: { type: Date },
  timesStudied: { type: Number, default: 0 },
  masteredCount: { type: Number, default: 0 },
}, { timestamps: true });

flashcardSetSchema.index({ userId: 1, contentId: 1 });
flashcardSetSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('FlashcardSet', flashcardSetSchema);
