const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const twilioClient = require('../config/twilio');
const User = require('../models/User');
const redis = require('../config/redis');
const ApiError = require('../utils/apiError');
const emailService = require('./emailService');
const Follow = require('../models/Follow');

const SCALEUP_ADMIN_ID = '699d8aeca7eb4b450fbd22e0';

class AuthService {

  constructor() {
    this.googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }

  generateAccessToken(user) {
    return jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m' },
    );
  }

  generateRefreshToken(user) {
    return jwt.sign(
      { userId: user._id, tokenVersion: user.tokenVersion },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRY || '30d' },
    );
  }

  _tokenPair(user) {
    return {
      accessToken: this.generateAccessToken(user),
      refreshToken: this.generateRefreshToken(user),
    };
  }

  _sanitize(user) {
    const obj = user.toObject();
    delete obj.password;
    delete obj.refreshTokenHash;
    delete obj.__v;
    return obj;
  }

  async register({ email, password, firstName, lastName }) {
    const existing = await User.findOne({ email });
    if (existing) throw new ApiError(409, 'An account with this email already exists');

    const user = await User.create({ email, password, firstName, lastName, authProvider: 'local' });
    try { await require('./institution/rosterClaimService').claimForUser(user); } catch (e) { console.error('[rosterClaim] non-fatal', e.message); }
    const tokens = this._tokenPair(user);

    emailService.sendWelcome(email, firstName).catch(() => {});
    this._autoFollowAdmin(user._id).catch(() => {});

    return { user: this._sanitize(user), ...tokens };
  }

  async login({ email, password }) {
    const user = await User.findOne({ email }).select('+password');
    if (!user) throw new ApiError(401, 'Invalid email or password');
    if (user.authProvider !== 'local') throw new ApiError(401, `This account uses ${user.authProvider} sign-in`);

    const isMatch = await user.comparePassword(password);
    if (!isMatch) throw new ApiError(401, 'Invalid email or password');
    if (user.isBanned) throw new ApiError(403, 'Your account has been suspended');

    const reactivationCheck = this._checkDeactivated(user);
    if (reactivationCheck) return reactivationCheck;

    user.lastLoginAt = new Date();
    await user.save();
    // Auto-merge: enrol an existing user who matches a pending college roster
    // (by email/phone). No-op for pure D2C users. Non-fatal.
    try { await require('./institution/rosterClaimService').claimForUser(user); } catch (e) { console.error('[rosterClaim] non-fatal', e.message); }

    return { user: this._sanitize(user), ...this._tokenPair(user) };
  }

  async googleLogin({ googleIdToken }) {
    let ticket;
    try {
      ticket = await this.googleClient.verifyIdToken({
        idToken: googleIdToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
    } catch {
      throw new ApiError(401, 'Invalid Google ID token');
    }

    const { sub: googleId, email, given_name: firstName, family_name: lastName, picture } = ticket.getPayload();
    if (!email) throw new ApiError(400, 'Google account does not have an email');

    let user = await User.findOne({ googleId });
    let isNewUser = false;
    if (!user) {
      user = await User.findOne({ email });
      if (user) {
        user.googleId = googleId;
        user.authProvider = 'google';
        if (!user.profilePicture && picture) user.profilePicture = picture;
      } else {
        isNewUser = true;
        user = new User({
          email, firstName: firstName || 'User', lastName: lastName || '',
          googleId, authProvider: 'google', profilePicture: picture, isEmailVerified: true,
        });
      }
    }

    if (user.isBanned) throw new ApiError(403, 'Your account has been suspended');

    const googleReactivationCheck = this._checkDeactivated(user);
    if (googleReactivationCheck) return googleReactivationCheck;

    user.lastLoginAt = new Date();
    await user.save();

    // Auto-merge: enrol a user who matches a pending college roster (by email). No-op for D2C-only. Non-fatal.
    try { await require('./institution/rosterClaimService').claimForUser(user); } catch (e) { console.error('[rosterClaim] non-fatal', e.message); }

    if (isNewUser) {
      this._autoFollowAdmin(user._id).catch(() => {});
    }

    return { user: this._sanitize(user), ...this._tokenPair(user) };
  }

  async refreshToken(token) {
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch {
      throw new ApiError(401, 'Invalid or expired refresh token');
    }

    const user = await User.findById(decoded.userId);
    if (!user) throw new ApiError(401, 'User no longer exists');
    if (decoded.tokenVersion !== user.tokenVersion) throw new ApiError(401, 'Refresh token revoked');
    if (user.isBanned) throw new ApiError(403, 'Your account has been suspended');
    if (!user.isActive) throw new ApiError(403, 'Account deactivated');

    return this._tokenPair(user);
  }

  async forgotPassword(email) {
    const user = await User.findOne({ email });
    if (!user) return { message: 'If an account with that email exists, an OTP has been sent' };

    const otp = crypto.randomInt(100000, 999999).toString();
    await redis.set(`otp:reset:${email}`, otp, 'EX', 600);
    await emailService.sendOTP(email, otp);

    return { message: 'If an account with that email exists, an OTP has been sent' };
  }

  async resetPassword({ email, otp, newPassword }) {
    const storedOtp = await redis.get(`otp:reset:${email}`);
    if (!storedOtp || storedOtp !== otp) throw new ApiError(400, 'Invalid or expired OTP');

    const user = await User.findOne({ email }).select('+password');
    if (!user) throw new ApiError(404, 'User not found');

    user.password = newPassword;
    user.tokenVersion += 1;
    await user.save();
    await redis.del(`otp:reset:${email}`);

    return { message: 'Password reset successfully' };
  }

  // ─── Phone OTP (Twilio) ──────────────────────────────────────────

  /**
   * Send OTP to a phone number for login/signup.
   * Stores OTP in Redis with a 5-minute TTL.
   */
  async sendPhoneOTP(phone) {
    const normalized = this._normalizePhone(phone);

    // Rate limit: 1 OTP per phone per 60 seconds
    const rateLimitKey = `otp:ratelimit:${normalized}`;
    const isRateLimited = await redis.get(rateLimitKey);
    if (isRateLimited) throw new ApiError(429, 'Please wait 60 seconds before requesting another OTP');

    const otp = crypto.randomInt(100000, 999999).toString();
    const otpKey = `otp:phone:${normalized}`;

    // Store OTP in Redis — expires in 5 minutes
    await redis.set(otpKey, otp, 'EX', 300);
    // Rate limit — 60 second cooldown
    await redis.set(rateLimitKey, '1', 'EX', 60);

    // Send SMS via Twilio
    await twilioClient.messages.create({
      body: `Your ScaleUp verification code is: ${otp}. It expires in 5 minutes.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: normalized,
    });

    return { message: 'OTP sent successfully', phone: normalized };
  }

  /**
   * Verify OTP and login/register the user.
   * - If the phone number belongs to an existing user → login
   * - If not → create a new account (firstName required in this case)
   */
  async verifyPhoneOTP({ phone, otp, firstName, lastName }) {
    const normalized = this._normalizePhone(phone);
    const otpKey = `otp:phone:${normalized}`;

    const storedOtp = await redis.get(otpKey);
    if (!storedOtp || storedOtp !== otp) {
      throw new ApiError(400, 'Invalid or expired OTP');
    }

    // OTP is valid — consume it
    await redis.del(otpKey);

    // Look up existing user by phone
    let user = await User.findOne({ phone: normalized });
    let isNewUser = false;

    if (user) {
      // Existing user — login
      if (user.isBanned) throw new ApiError(403, 'Your account has been suspended');

      const phoneReactivationCheck = this._checkDeactivated(user);
      if (phoneReactivationCheck) return phoneReactivationCheck;

      user.isPhoneVerified = true;
      user.lastLoginAt = new Date();
      await user.save();
      try { await require('./institution/rosterClaimService').claimForUser(user); } catch (e) { console.error('[rosterClaim] non-fatal', e.message); }
    } else {
      // Phone not registered — tell the client to go through full registration
      return { needsRegistration: true, phone: normalized };
    }

    return {
      user: this._sanitize(user),
      isNewUser,
      ...this._tokenPair(user),
    };
  }

  /**
   * Verify/link a phone number for an already authenticated user.
   * Step 1: sendPhoneOTP (already exists above)
   * Step 2: this method verifies the OTP and links the phone to the user's account
   */
  async verifyPhoneForUser(userId, { phone, otp }) {
    const normalized = this._normalizePhone(phone);
    const otpKey = `otp:phone:${normalized}`;

    const storedOtp = await redis.get(otpKey);
    if (!storedOtp || storedOtp !== otp) {
      throw new ApiError(400, 'Invalid or expired OTP');
    }

    // Check if another user already has this phone
    const existing = await User.findOne({ phone: normalized, _id: { $ne: userId } });
    if (existing) throw new ApiError(409, 'This phone number is already linked to another account');

    await redis.del(otpKey);

    const user = await User.findByIdAndUpdate(userId, {
      phone: normalized,
      isPhoneVerified: true,
    }, { new: true });

    return { message: 'Phone number verified and linked', phone: normalized };
  }

  /**
   * Normalize phone to E.164 format.
   * Expects input like "+919876543210" or "9876543210" (assumes +91 for India).
   */
  _normalizePhone(phone) {
    let cleaned = phone.replace(/[\s\-()]/g, '');
    if (!cleaned.startsWith('+')) {
      // Default to India (+91) if no country code
      if (cleaned.length === 10) {
        cleaned = '+91' + cleaned;
      } else {
        cleaned = '+' + cleaned;
      }
    }
    if (cleaned.length < 10 || cleaned.length > 15) {
      throw new ApiError(400, 'Invalid phone number');
    }
    return cleaned;
  }

  /**
   * Auto-follow the ScaleUp Admin account so new users see curated content immediately.
   */
  async _autoFollowAdmin(userId) {
    const adminId = SCALEUP_ADMIN_ID;
    if (userId.toString() === adminId) return;

    await Follow.create({ followerId: userId, followingId: adminId });
    await User.findByIdAndUpdate(userId, { $inc: { followingCount: 1 } });
    await User.findByIdAndUpdate(adminId, { $inc: { followersCount: 1 } });
  }

  /**
   * Check if a user is deactivated. Returns a reactivation response if within
   * the 30-day grace period, or throws if the account is permanently gone.
   */
  _checkDeactivated(user) {
    if (user.isActive) return null;

    const GRACE_PERIOD_DAYS = 30;
    const deactivatedAt = user.deletedAt || user.updatedAt;
    const daysSince = Math.floor((Date.now() - new Date(deactivatedAt).getTime()) / (1000 * 60 * 60 * 24));

    if (daysSince > GRACE_PERIOD_DAYS) {
      throw new ApiError(403, 'This account has been permanently deleted.');
    }

    return {
      needsReactivation: true,
      deactivatedAt,
      daysRemaining: GRACE_PERIOD_DAYS - daysSince,
      userId: user._id,
    };
  }

  /**
   * Reactivate a deactivated account within the 30-day grace period.
   * Called after the user confirms reactivation from the frontend.
   */
  async reactivate({ email, password, googleIdToken, phone, otp }) {
    let user;

    if (googleIdToken) {
      let ticket;
      try {
        ticket = await this.googleClient.verifyIdToken({
          idToken: googleIdToken,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
      } catch {
        throw new ApiError(401, 'Invalid Google ID token');
      }
      const { sub: googleId } = ticket.getPayload();
      user = await User.findOne({ googleId }).select('+password');
      if (!user) user = await User.findOne({ email: ticket.getPayload().email }).select('+password');
    } else if (phone && otp) {
      const normalized = this._normalizePhone(phone);
      const redis = require('../config/redis');
      const otpKey = `otp:phone:${normalized}`;
      const storedOtp = await redis.get(otpKey);
      if (!storedOtp || storedOtp !== otp) throw new ApiError(400, 'Invalid or expired OTP');
      await redis.del(otpKey);
      user = await User.findOne({ phone: normalized }).select('+password');
    } else if (email && password) {
      user = await User.findOne({ email }).select('+password');
      if (!user) throw new ApiError(401, 'Invalid credentials');
      const isMatch = await user.comparePassword(password);
      if (!isMatch) throw new ApiError(401, 'Invalid credentials');
    } else {
      throw new ApiError(400, 'Credentials required for reactivation');
    }

    if (!user) throw new ApiError(404, 'Account not found');
    if (user.isActive) throw new ApiError(400, 'Account is already active');
    if (user.isBanned) throw new ApiError(403, 'Your account has been suspended');

    const GRACE_PERIOD_DAYS = 30;
    const deactivatedAt = user.deletedAt || user.updatedAt;
    const daysSince = Math.floor((Date.now() - new Date(deactivatedAt).getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince > GRACE_PERIOD_DAYS) {
      throw new ApiError(403, 'This account has been permanently deleted.');
    }

    // Reactivate
    user.isActive = true;
    user.deletedAt = undefined;
    user.lastLoginAt = new Date();
    await user.save();

    // Restore account data (unhide content, resume journeys, fix follow counts)
    const deactivationService = require('./deactivationService');
    await deactivationService.restoreAccount(user._id);

    // Clear auth middleware cache
    const auth = require('../middleware/auth');
    auth.clearCache(user._id.toString());

    return { user: this._sanitize(user), ...this._tokenPair(user), reactivated: true };
  }

  async logout(userId) {
    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');
    user.tokenVersion += 1;
    await user.save();
    return { message: 'Logged out successfully' };
  }
}

module.exports = new AuthService();
