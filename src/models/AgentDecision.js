'use strict';

const mongoose = require('mongoose');

/**
 * One agent output + what the human did with it + what happened after.
 *
 * This is the feedback-loop backbone for the agentic layer: every proposal,
 * artifact, brief, or nudge any agent produces writes exactly one row here.
 * The row is UPDATED later as reality responds:
 *   - humanSignal via POST /api/v2/agent/decisions/:id/respond
 *   - `ignored` via the daily expiry sweep (pending > AGENT_DECISION_TTL_HOURS)
 *   - outcomeSignal by per-agent closure jobs (Plan 2+)
 *
 * promptVersion + modelId make improvement attributable: replay evals compare
 * acceptance/outcome rates across versions before any prompt change deploys.
 * adjustmentDiff (what the human changed before accepting) is the highest-value
 * training signal — never discard it.
 */
const AgentDecisionSchema = new mongoose.Schema(
  {
    agentId: {
      type: String,
      required: true,
      // One id per agent from the approved roadmap; extend as agents ship.
      enum: [
        'compass_actions',      // #2
        'recalibration_coach',  // #6
        'misconception_tutor',  // #7
        'interview_coach',      // #4
        'proof_builder',        // #8
        'author_agent',         // #1
        'intervention',         // #3
        'activation',           // #10
        'review_triage',        // #9
        'ops_sentinel',         // #12
      ],
      index: true,
    },
    decisionType: {
      type: String,
      required: true,
      enum: ['proposal', 'artifact', 'brief', 'nudge', 'recommendation'],
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution' },
    cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort' },

    // What the agent saw when it decided (compact — ids and numbers, not blobs).
    contextSnapshot: { type: mongoose.Schema.Types.Mixed },
    // What it proposed/created. For compass_actions proposals:
    // { title, summary, consequence, ops: [{op, taskId?, status?}] }
    action: { type: mongoose.Schema.Types.Mixed, required: true },

    promptVersion: { type: String },
    modelId: { type: String },
    toolTrace: { type: [String], default: undefined },

    status: {
      type: String,
      enum: ['pending', 'accepted', 'adjusted', 'rejected', 'ignored'],
      default: 'pending',
      index: true,
    },
    // Present only when status === 'adjusted': the ops the human actually applied.
    adjustmentDiff: { type: mongoose.Schema.Types.Mixed },
    respondedAt: { type: Date },

    // Filled by closure jobs later (agent-specific: task completion, readiness
    // delta, claim rate…). Shape is per-agent; keep Mixed.
    outcomeSignal: { type: mongoose.Schema.Types.Mixed },

    costUsd: { type: Number },
  },
  { timestamps: true }
);

AgentDecisionSchema.index({ userId: 1, status: 1, createdAt: -1 });
AgentDecisionSchema.index({ agentId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('AgentDecision', AgentDecisionSchema);
