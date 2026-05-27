'use strict';

const mongoose = require('mongoose');

/**
 * PairingCode — short-lived 6-digit handoff between mobile and laptop
 * (spec §7.2 step 3, §7.3 message `session.pair`).
 *
 * Mongo TTL index on `expires_at` purges expired codes automatically — no
 * cron needed. Default validity is 10 min (TEN_MIN_MS in pairingService.js).
 *
 * The `code` itself is the primary key for lookup (laptop POSTs the code, we
 * find the matching doc). `used_at` ensures a code is single-use: once
 * redeemed, a second attempt finds no match (or finds the row but with
 * `used_at` set, depending on the redeem strategy — see pairingService).
 */
const PairingCodeSchema = new mongoose.Schema(
  {
    // 6-digit numeric, zero-padded. Indexed unique so collisions are caught
    // at insert time and pairingService can retry with a fresh draw.
    code: { type: String, required: true, unique: true, index: true },

    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    session_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CapstoneSession',
      required: true,
    },

    // Mongo TTL index: { expireAfterSeconds: 0 } means "expire at the time
    // stored in this field." Documents are reaped within ~60s of expiry.
    expires_at: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },

    // Set on redemption. Existence indicates the code has been used (mobile
    // shows "already paired" if a second laptop tries — spec §12.1).
    used_at: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('PairingCode', PairingCodeSchema);
