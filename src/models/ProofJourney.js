'use strict';

const mongoose = require('mongoose');

/**
 * ProofJourney — the proof-builder agent (#8, flag `proof_builder`).
 *
 * Stitches the existing JD→capstone→grade→publish pipeline into one tracked
 * journey: a learner pastes a job description, the agent extracts a compact
 * skill summary (ONE LLM call — see proofJourneyService.extractJdSkills),
 * kicks capstone generation through the EXISTING JD-paste entry point
 * (capstoneAuthoringSupport.requestGeneration — never a parallel path), and
 * the journey advances as the underlying capstone session is graded and the
 * learner publishes their readiness proof (proofService.publish).
 *
 * Status lifecycle (client-visible checklist progress):
 *   extracting → capstone_pending → building → grading → publishable → published
 *                                                                    ↘ failed (any stage)
 *
 * NOTE on capstoneRef: `bundleId`/`sessionId` are populated as the underlying
 * capstone moves through ITS OWN lifecycle (CapstoneGenerationRequest ready →
 * learner starts an attempt → CapstoneSession graded). Task 3/4 of this plan
 * wire the generation kickoff and the post-grade hook (advanceOnCapstoneGraded
 * matches by capstoneRef.sessionId); backfilling sessionId once the learner
 * actually starts the generated bundle is a known follow-up (no "session
 * started" hook exists yet in the plan) — see proofJourneyService docs.
 *
 * `ledgerDecisionId` is additive plumbing (not in the original field list but
 * required to satisfy it): the single AgentDecision ledger row created in
 * startJourney is later mutated in place — outcomeSignal on grade,
 * status:'accepted' on publish — so the service needs to find it again by id
 * rather than re-querying the ledger by loose match criteria.
 */
const stepSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  status: { type: String, enum: ['done', 'now', 'todo', 'failed'], default: 'todo' },
  at: { type: Date },
}, { _id: false });

const capstoneRefSchema = new mongoose.Schema({
  bundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtifactBundle', default: null },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CapstoneSession', default: null },
}, { _id: false });

const jdSummarySchema = new mongoose.Schema({
  role: { type: String },
  company: { type: String },
  skills: { type: [String], default: [] },
}, { _id: false });

const nextProofSuggestionSchema = new mongoose.Schema({
  skill: { type: String },
  reason: { type: String },
}, { _id: false });

const proofJourneySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  jdText: { type: String, required: true, maxlength: 20000 },
  jdSummary: { type: jdSummarySchema, default: () => ({}) },

  status: {
    type: String,
    enum: ['extracting', 'capstone_pending', 'building', 'grading', 'publishable', 'published', 'failed'],
    default: 'extracting',
  },

  capstoneRef: { type: capstoneRefSchema, default: () => ({}) },
  proofToken: { type: String, default: null },

  steps: { type: [stepSchema], default: [] },
  nextProofSuggestion: { type: nextProofSuggestionSchema, default: null },

  ledgerDecisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AgentDecision' },
}, { timestamps: true });

proofJourneySchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('ProofJourney', proofJourneySchema);
