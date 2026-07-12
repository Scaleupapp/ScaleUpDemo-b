'use strict';

/**
 * The feedback-loop service for the agentic layer.
 *
 * Every agent output is recorded here as PENDING; the human's response
 * (accept / adjust / reject) or the expiry sweep (ignore) closes the loop.
 * Accepted/adjusted plan proposals are APPLIED here too — through the same
 * Plan mutations the existing v2 routes use, never through new write paths.
 *
 * All functions take an optional `deps` for test injection (repo convention:
 * zero network/DB in tests).
 */

const OP_WHITELIST = new Set(['set_task_status', 'reset_skipped']);
const STATUS_WHITELIST = new Set(['skipped', 'complete', 'pending']);

function defaultDeps() {
  return {
    AgentDecision: require('../models/AgentDecision'),
    Plan: require('../models/Plan'),
    notify: (userId) =>
      require('./notificationService').createInApp(userId, {
        type: 'recalibration_offer',
        title: 'Fresh check-in, fresh plan',
        message: 'Quick recalibration → your plan updates to match where you are now.',
        deepLink: null,
      }),
  };
}

async function record(payload, deps = {}) {
  const { AgentDecision } = { ...defaultDeps(), ...deps };
  return AgentDecision.create({
    agentId: payload.agentId,
    decisionType: payload.decisionType,
    userId: payload.userId,
    institutionId: payload.institutionId,
    cohortId: payload.cohortId,
    contextSnapshot: payload.contextSnapshot,
    action: payload.action,
    promptVersion: payload.promptVersion,
    modelId: payload.modelId,
    toolTrace: payload.toolTrace,
  });
}

/**
 * Execute a whitelisted op list against the user's active plan.
 * Validates EVERYTHING before applying ANYTHING (no partial applies on bad input).
 */
async function applyPlanOps(userId, ops, deps = {}) {
  const { Plan } = { ...defaultDeps(), ...deps };
  const list = Array.isArray(ops) ? ops : [];

  for (const op of list) {
    if (!op || !OP_WHITELIST.has(op.op)) {
      throw new Error(`unsupported op: ${op && op.op}`);
    }
    if (op.op === 'set_task_status') {
      if (!op.taskId) throw new Error('set_task_status requires taskId');
      if (!STATUS_WHITELIST.has(op.status)) throw new Error(`unsupported status: ${op.status}`);
    }
  }

  let applied = 0;
  for (const op of list) {
    if (op.op === 'set_task_status') {
      const update = {
        'weeklySchedule.$[].tasks.$[t].progress.status': op.status,
      };
      if (op.status === 'complete') {
        update['weeklySchedule.$[].tasks.$[t].progress.completedAt'] = new Date();
      }
      const result = await Plan.updateOne(
        { userId, isActive: true },
        { $set: update },
        { arrayFilters: [{ 't._id': op.taskId }] }
      );
      if (result.matchedCount === 0) {
        throw new Error('active plan not found');
      }
      if (result.modifiedCount === 0) {
        throw new Error('task not found in active plan');
      }
      applied += 1;
    } else if (op.op === 'reset_skipped') {
      const result = await Plan.updateOne(
        { userId, isActive: true },
        { $set: { 'weeklySchedule.$[].tasks.$[t].progress.status': 'pending' } },
        { arrayFilters: [{ 't.progress.status': 'skipped' }] }
      );
      if (result.matchedCount === 0) {
        throw new Error('active plan not found');
      }
      applied += 1;
    }
  }
  return { applied };
}

async function respond({ decisionId, userId, response, adjustedOps }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const decision = await d.AgentDecision.findById(decisionId);
  // Ownership check folds into "not found" so we don't leak decision existence.
  if (!decision || String(decision.userId) !== String(userId)) {
    throw new Error('decision not found');
  }
  if (decision.status !== 'pending') {
    throw new Error(`decision already ${decision.status}`);
  }
  if (!['accepted', 'adjusted', 'rejected'].includes(response)) {
    throw new Error(`unsupported response: ${response}`);
  }

  const kind = (decision.action && decision.action.kind) || 'plan_ops';

  let applied = false;
  switch (kind) {
    case 'plan_ops': {
      if (response === 'adjusted' && (!Array.isArray(adjustedOps) || adjustedOps.length === 0)) {
        throw new Error('unsupported response: adjusted requires non-empty adjustedOps');
      }
      if (response === 'accepted' || response === 'adjusted') {
        const ops = response === 'adjusted' ? adjustedOps : (decision.action && decision.action.ops);
        await applyPlanOps(String(decision.userId), ops || [], d);
        applied = true;
      }
      break;
    }
    case 'recalibration_offer': {
      if (response === 'adjusted') {
        throw new Error('unsupported response: adjusted not allowed for recalibration_offer');
      }
      if (response === 'accepted') {
        await d.notify(String(decision.userId));
        applied = true;
      }
      break;
    }
    default:
      throw new Error(`unsupported action kind: ${kind}`);
  }

  decision.status = response;
  if (response === 'adjusted') decision.adjustmentDiff = adjustedOps;
  decision.respondedAt = new Date();
  await decision.save();
  return { decision, applied };
}

async function expireStale({ hours = 48 } = {}, deps = {}) {
  const { AgentDecision } = { ...defaultDeps(), ...deps };
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const r = await AgentDecision.updateMany(
    { status: 'pending', createdAt: { $lt: cutoff } },
    { $set: { status: 'ignored' } }
  );
  return { expired: r.modifiedCount || 0 };
}

module.exports = { record, respond, applyPlanOps, expireStale };
