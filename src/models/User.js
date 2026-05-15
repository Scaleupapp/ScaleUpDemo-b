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
  role: { type: String, enum: ['consumer', 'contributor', 'creator', 'admin'], default: 'consumer' },
  authProvider: { type: String, enum: ['local', 'google', 'linkedin', 'phone'], default: 'local' },
  googleId: { type: String, sparse: true },
  linkedinId: { type: String, sparse: true },
  refreshTokenHash: { type: String, select: false },
  tokenVersion: { type: Number, default: 1 },

  // --- Onboarding ---
  onboardingComplete: { type: Boolean, default: false },
  onboardingStep: { type: Number, default: 0 },
  // Diagnostic completion — read by the client at launch to route past the
  // diagnostic. Written by diagnosticService.finishAttempt and the v2
  // plan-generate route. (Was missing from the schema, so strict mode
  // silently dropped every write — the cause of the re-onboarding loop.)
  diagnosticComplete: { type: Boolean, default: false },

  // --- v2 redesign opt-in (synced from iOS/Android client flag) ---
  // When true, server-side workers suppress v1 anti-thesis notifications
  // (streak-panic, generic-trending) so v2 users get the calmer experience.
  v2OptedIn: { type: Boolean, default: false, index: true },
  v2OptedInAt: { type: Date },
  // True between opting into v2 and finishing the v2 onboarding flow. New
  // users (no prior data) and existing users who accept the "try v2" prompt
  // both get this set; it's cleared once the v2 plan is generated.
  v2NeedsOnboarding: { type: Boolean, default: false },
  // Last time the existing-user "try v2" prompt was shown — drives the
  // "ask again later" cooldown so we don't nag on every launch.
  v2PromptLastShownAt: { type: Date },

  // --- Engagement (denormalized counters) ---
  followersCount: { type: Number, default: 0 },
  followingCount: { type: Number, default: 0 },

  // --- Contributor Stats (for notes uploaders) ---
  contributorStats: {
    totalNotes: { type: Number, default: 0 },
    totalViews: { type: Number, default: 0 },
    totalSaves: { type: Number, default: 0 },
    requestsFulfilled: { type: Number, default: 0 },
  },

  // --- Verified Contributor ---
  isVerifiedContributor: { type: Boolean, default: false },
  verifiedContributorAt: { type: Date },

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
