const mongoose = require('mongoose');

const creatorProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  tier: { type: String, enum: ['rising', 'core', 'anchor'], default: 'rising' },
  domain: { type: String, lowercase: true, trim: true },
  specializations: [{ type: String, lowercase: true, trim: true }],
  bio: { type: String, maxlength: 1000 },

  stats: {
    totalContent: { type: Number, default: 0 },
    totalViews: { type: Number, default: 0 },
    totalFollowers: { type: Number, default: 0 },
    averageRating: { type: Number, default: 0 },
    totalQuizzesGenerated: { type: Number, default: 0 },
  },

  isVerified: { type: Boolean, default: false },
  verifiedAt: { type: Date },
}, { timestamps: true });

creatorProfileSchema.index({ userId: 1 });
creatorProfileSchema.index({ tier: 1, domain: 1 });

module.exports = mongoose.model('CreatorProfile', creatorProfileSchema);
