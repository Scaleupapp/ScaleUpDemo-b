const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const educationSchema = new mongoose.Schema({
  degree: { type: String, trim: true },
  institution: { type: String, trim: true },
  yearOfCompletion: { type: Number },
  currentlyPursuing: { type: Boolean, default: false },
}, { _id: false });

const workExperienceSchema = new mongoose.Schema({
  role: { type: String, trim: true },
  company: { type: String, trim: true },
  years: { type: Number },
  currentlyWorking: { type: Boolean, default: false },
}, { _id: false });

const userSchema = new mongoose.Schema({
  // --- Identity ---
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, select: false },
  phone: { type: String, unique: true, sparse: true },
  isPhoneVerified: { type: Boolean, default: false },
  isEmailVerified: { type: Boolean, default: false },

  // --- Profile ---
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, trim: true },
  username: { type: String, unique: true, lowercase: true, trim: true, sparse: true },
  profilePicture: { type: String },
  bio: { type: String, maxlength: 300 },
  dateOfBirth: { type: Date },
  location: { type: String },

  // --- Education & Work ---
  education: [educationSchema],
  workExperience: [workExperienceSchema],
  skills: [{ type: String, lowercase: true, trim: true }],

  // --- Role & Auth ---
  role: { type: String, enum: ['consumer', 'creator', 'admin'], default: 'consumer' },
  authProvider: { type: String, enum: ['local', 'google', 'linkedin', 'phone'], default: 'local' },
  googleId: { type: String, sparse: true },
  linkedinId: { type: String, sparse: true },
  refreshTokenHash: { type: String, select: false },
  tokenVersion: { type: Number, default: 1 },

  // --- Onboarding ---
  onboardingComplete: { type: Boolean, default: false },
  onboardingStep: { type: Number, default: 0 },

  // --- Engagement (denormalized counters) ---
  followersCount: { type: Number, default: 0 },
  followingCount: { type: Number, default: 0 },

  // --- Device & Notifications ---
  fcmToken: { type: String },
  deviceType: { type: String, enum: ['ios', 'android', 'web'] },

  // --- Consent (GDPR) ---
  consentTerms: { type: Date },        // when user accepted Terms of Service
  consentTermsVersion: { type: String }, // which version they accepted
  consentPrivacy: { type: Date },       // when user accepted Privacy Policy
  consentPrivacyVersion: { type: String },
  consentMarketing: { type: Date },     // optional marketing consent
  consentWithdrawnAt: { type: Date },   // if user withdrew consent

  // --- Status ---
  isActive: { type: Boolean, default: true },
  isBanned: { type: Boolean, default: false },
  isPermanentlyDeleted: { type: Boolean, default: false },
  lastLoginAt: { type: Date },
  deletedAt: { type: Date },
}, { timestamps: true });

userSchema.index({ email: 1 });
userSchema.index({ username: 1 });
userSchema.index({ role: 1 });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
