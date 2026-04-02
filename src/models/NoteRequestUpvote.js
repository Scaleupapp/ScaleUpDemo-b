const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  noteRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'NoteRequest', required: true },
}, { timestamps: true });

schema.index({ userId: 1, noteRequestId: 1 }, { unique: true });

module.exports = mongoose.model('NoteRequestUpvote', schema);
