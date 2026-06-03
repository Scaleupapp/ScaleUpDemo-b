// src/models/EmployerAccount.js
'use strict';
const mongoose = require('mongoose');

// A hiring-side account. Two access tiers: emailVerified => BROWSE, approvalStatus:'approved' => CONTACT.
const EmployerAccountSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    companyName: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    title: { type: String, trim: true },
    linkedIn: { type: String, trim: true },
    role: { type: String, default: 'employer' },

    emailVerified: { type: Boolean, default: false }, // -> browse tier
    approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }, // approved -> contact tier
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date },

    // single-use tokens (hashed) for magic-link verify/login
    authTokenHash: { type: String, default: null },
    authTokenExpires: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmployerAccount', EmployerAccountSchema);
