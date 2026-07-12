'use strict';

const mongoose = require('mongoose');

/**
 * InterviewProgram — a coached multi-week interview prep program (agentic
 * layer #4, flag `interview_coach`). Turns one-off mock interviews into a
 * tracked sequence: sessions attach as they're completed, and the focus
 * engine (interviewProgramService.computeNextFocus) recommends which
 * dimension to work on next based on score trends across attached sessions.
 *
 * ONE active program per user: enforced two ways —
 *   1. Application-level: the service does a findOne({userId,status:'active'})
 *      guard before create() and throws a clean 'program already active'
 *      Error (mapped to HTTP 409 by the route layer's message-regex, same
 *      house style as agentDecisions.js).
 *   2. Database-level backstop for the race window between that check and
 *      the create: a partial unique index on {userId} scoped to
 *      status:'active' (same pattern as DiagnosticAttempt's
 *      one_active_attempt_per_user). A concurrent second create() gets a
 *      duplicate-key error (11000), which the service also translates to
 *      the same 'program already active' message.
 */
const focusHistoryEntrySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  dimension: { type: String, required: true },
  reason: { type: String },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'InterviewSession' },
}, { _id: false });

const interviewProgramSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  targetRole: { type: String },
  targetCompany: { type: String },
  driveDate: { type: Date },

  status: {
    type: String,
    enum: ['active', 'completed', 'abandoned'],
    default: 'active',
  },
  weeks: { type: Number, default: 4 },

  sessionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'InterviewSession' }],
  focusHistory: [focusHistoryEntrySchema],
}, { timestamps: true });

interviewProgramSchema.index({ userId: 1, status: 1 });
interviewProgramSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
    name: 'one_active_program_per_user',
  },
);

module.exports = mongoose.model('InterviewProgram', interviewProgramSchema);
