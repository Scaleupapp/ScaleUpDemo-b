const mongoose = require('mongoose');
const PlacementOfferSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true, index: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionEnrollment' },
  studentName: { type: String, required: true, trim: true },
  rollNumber: { type: String, trim: true },
  branch: { type: String, trim: true },
  companyName: { type: String, required: true, trim: true },
  driveId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlacementDrive' },
  role: { type: String, trim: true },
  ctc: { type: Number },                 // LPA
  offerType: { type: String, enum: ['full_time', 'internship'], default: 'full_time' },
  status: { type: String, enum: ['offered', 'accepted', 'joined', 'declined'], default: 'offered' },
  offerDate: { type: Date },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });
PlacementOfferSchema.index({ institutionId: 1, cohortId: 1, status: 1 });
module.exports = mongoose.models.PlacementOffer || mongoose.model('PlacementOffer', PlacementOfferSchema);
