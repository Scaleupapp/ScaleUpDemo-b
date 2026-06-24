const mongoose = require('mongoose');

const AssessmentSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  type: { type: String, enum: ['mcq', 'capstone', 'interview', 'drill'], required: true },
  title: { type: String, required: true, trim: true },
  // Engine-specific config, frozen at release. Only the sub-object matching `type` is used.
  config: {
    mcq: {
      questions: { type: Array, default: undefined }, // frozen canonical question set (Quiz.questions shape)
      totalQuestions: Number,
      durationSeconds: { type: Number, default: 1800 },
      assessmentType: String,
      topic: String,
      sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssessmentSource' },
    },
    capstone: {
      bundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtifactBundle' },
      durationSeconds: { type: Number, default: 5400 },
      roleTrack: String,
      difficulty: { type: String, default: 'medium' },
      jobDescription: String,
      topicHint: String,
      sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssessmentSource' },
    },
    interview: {
      interviewType: { type: String },
      targetRole: String,
      difficulty: { type: String, default: 'moderate' },
      durationSeconds: { type: Number, default: 1800 },
      sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssessmentSource' },
    },
    drill: {
      roleTrack: String,
      drillSubtype: String,
      difficulty: { type: String, default: 'medium' },
      bundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtifactBundle' },
      sourceId: mongoose.Schema.Types.ObjectId,
    },
  },
  integrityRequired: { type: Boolean, default: true },
  opensAt: { type: Date },
  closesAt: { type: Date },
  status: { type: String, enum: ['draft', 'configured', 'released', 'closed'], default: 'draft' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
  releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
  releasedAt: { type: Date },
  closedAt: { type: Date },
}, { timestamps: true });

AssessmentSchema.index({ institutionId: 1, cohortId: 1, status: 1 });

module.exports = mongoose.models.Assessment || mongoose.model('Assessment', AssessmentSchema);
