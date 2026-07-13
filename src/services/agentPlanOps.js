'use strict';

/**
 * Single source of truth for the plan-op whitelist shared by the two places
 * that validate agent-proposed plan mutations:
 *   - agentDecisionService.applyPlanOps (applies accepted/adjusted ops)
 *   - compassProposalTools (validates a tool call before it is ever proposed)
 *
 * Keep both arrays and Set forms exported: arrays for JSON-schema `enum`
 * lists (compassProposalTools' tool input_schema), Sets for O(1) membership
 * checks in the two validators above.
 */

const OPS = ['set_task_status', 'reset_skipped'];
const STATUSES = ['skipped', 'complete', 'pending'];

const OP_WHITELIST = new Set(OPS);
const STATUS_WHITELIST = new Set(STATUSES);

module.exports = { OPS, STATUSES, OP_WHITELIST, STATUS_WHITELIST };
