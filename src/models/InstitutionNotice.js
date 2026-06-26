const mongoose = require('mongoose');
const InstitutionNoticeSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true, index: true },
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true, trim: true },
  pinned: { type: Boolean, default: false },
  link: { type: String, trim: true },
  attachment: {
    type: new mongoose.Schema({
      s3Key: { type: String, required: true },
      fileName: { type: String, trim: true },
      mime: { type: String, trim: true },
    }, { _id: false }),
    default: undefined,
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });
InstitutionNoticeSchema.index({ institutionId: 1, cohortId: 1, pinned: -1, createdAt: -1 });
module.exports = mongoose.models.InstitutionNotice || mongoose.model('InstitutionNotice', InstitutionNoticeSchema);
