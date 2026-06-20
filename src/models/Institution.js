const mongoose = require('mongoose');
const InstitutionSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['college', 'university'], default: 'college' },
  location: String,
  affiliatingUniversity: String,
  logoUrl: String,
  brandColor: { type: String, default: '#F2C75A' },
  tpoContact: { name: String, email: String, phone: String },
  billingContact: { name: String, email: String, phone: String },
  seatsLicensed: { type: Number, default: 0 },
  seatsUsed: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
}, { timestamps: true });
module.exports = mongoose.models.Institution || mongoose.model('Institution', InstitutionSchema);
