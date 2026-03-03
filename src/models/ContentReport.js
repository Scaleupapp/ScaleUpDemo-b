const mongoose = require('mongoose');

const contentReportSchema = new mongoose.Schema({
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason: {
    type: String,
    enum: ['inappropriate', 'spam', 'misleading', 'copyright', 'harassment', 'other'],
    required: true,
  },
  description: { type: String, maxlength: 500 },
}, { timestamps: true });

contentReportSchema.index({ contentId: 1, reporterId: 1 }, { unique: true });
contentReportSchema.index({ contentId: 1 });

module.exports = mongoose.model('ContentReport', contentReportSchema);
