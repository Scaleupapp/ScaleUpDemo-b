'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Opt-in, revocable public share token for a learner's coding profile.
 *
 * Privacy model (founder decision): a share link exposes SCORES + COMPETENCY
 * SUMMARY ONLY — overall scores, per-dimension mastery, capstone titles +
 * difficulty, integrity confidence. NEVER the learner's code, the full briefs,
 * their email, or anything that could leak bundle solutions. The public
 * endpoint enforces that projection; this model just holds the token.
 *
 * The token is a long random string (treat like a password). A learner may
 * have multiple active tokens (e.g. one per recruiter) and can revoke any.
 */
const ShareTokenSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    label: { type: String, default: '' }, // optional learner note, e.g. "Razorpay"
    is_revoked: { type: Boolean, default: false },
    view_count: { type: Number, default: 0 },
    last_viewed_at: { type: Date, default: null },
    // Optional expiry; null = never. TTL index drops expired docs.
    expires_at: { type: Date, default: null },
  },
  { timestamps: true }
);

ShareTokenSchema.index({ user_id: 1, is_revoked: 1 });
ShareTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

/** Mint a fresh URL-safe token (24 bytes → 32 base64url chars). */
ShareTokenSchema.statics.mintToken = function mintToken() {
  return crypto.randomBytes(24).toString('base64url');
};

module.exports =
  mongoose.models.ShareToken || mongoose.model('ShareToken', ShareTokenSchema);
