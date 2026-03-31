const mongoose = require('mongoose');

const collegeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  nameNormalized: { type: String, required: true, index: true },
  fullName: { type: String },
  district: { type: String },
  state: { type: String },
  type: { type: String }, // government, private, university, etc.
  source: { type: String }, // aicte, ugc, alias
}, { timestamps: false });

// Text index for search
collegeSchema.index({ nameNormalized: 'text', name: 'text' });

module.exports = mongoose.model('College', collegeSchema);
