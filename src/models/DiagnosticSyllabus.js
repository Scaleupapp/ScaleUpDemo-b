const mongoose = require('mongoose');

const EXTRACTION_STATUSES = ['pending', 'processing', 'completed', 'failed'];

const extractedTopicSchema = new mongoose.Schema(
  {
    canonicalName: { type: String, required: true },
    displayName: { type: String, required: true },
    description: { type: String, default: '' },
  },
  { _id: false }
);

const diagnosticSyllabusSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userObjectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', required: true },
    s3Key: { type: String, required: true },
    contentType: { type: String, required: true },
    fileSizeBytes: { type: Number, required: true, min: 0 },
    contentHash: { type: String, required: true },
    extractionStatus: { type: String, enum: EXTRACTION_STATUSES, default: 'pending', index: true },
    extractedText: { type: String, default: '' },
    pageCount: { type: Number, default: 0 },
    extractedTopics: { type: [extractedTopicSchema], default: [] },
    derivedQuestionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DiagnosticQuestionBank' }],
    reusedFromHash: { type: String, default: null },
    failureReason: { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

diagnosticSyllabusSchema.index({ userId: 1, createdAt: -1 });
diagnosticSyllabusSchema.index({ contentHash: 1 }, { unique: true });

module.exports = mongoose.model('DiagnosticSyllabus', diagnosticSyllabusSchema);
module.exports.EXTRACTION_STATUSES = EXTRACTION_STATUSES;
