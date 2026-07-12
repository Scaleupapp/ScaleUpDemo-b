'use strict';

/**
 * Outcome-closure sweep for compass_actions proposals.
 *
 * Accepted/adjusted decisions get an implicit follow-through signal once
 * enough time has passed: did the task statuses the human agreed to still
 * hold in their active plan? This closes the feedback loop that
 * agentDecisionService started — pending/accepted/adjusted/rejected only
 * tells us what the human clicked, not whether it stuck.
 *
 * Never throws per-row: a single bad decision (missing plan, save conflict,
 * malformed ops) must not stop the rest of the batch from closing.
 */

function defaultDeps() {
  return {
    AgentDecision: require('../models/AgentDecision'),
    Plan: require('../models/Plan'),
  };
}

function opsToCheck(row) {
  const ops = row.status === 'adjusted' ? row.adjustmentDiff : (row.action && row.action.ops);
  return Array.isArray(ops) ? ops : [];
}

async function closeCompassActionOutcomes({ olderThanHours = 24 } = {}, deps = {}) {
  const { AgentDecision, Plan } = { ...defaultDeps(), ...deps };
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

  const rows = await AgentDecision.find({
    agentId: 'compass_actions',
    status: { $in: ['accepted', 'adjusted'] },
    outcomeSignal: null,
    respondedAt: { $lt: cutoff },
  }).exec();

  let closed = 0;

  for (const row of rows) {
    try {
      const ops = opsToCheck(row);
      const statusOps = ops.filter((op) => op && op.op === 'set_task_status');
      const checkedAt = new Date();

      if (statusOps.length === 0) {
        // Only reset_skipped (or no ops at all) — nothing verifiable per-task,
        // but still close it so the sweep doesn't re-scan it forever.
        row.outcomeSignal = {
          kind: 'plan_ops_followthrough',
          checkedAt,
          ops: [],
          followedThrough: null,
        };
        await row.save();
        closed += 1;
        continue;
      }

      const plan = await Plan.findOne({ userId: row.userId, isActive: true }).lean();

      if (!plan) {
        row.outcomeSignal = {
          kind: 'plan_ops_followthrough',
          checkedAt,
          ops: [],
          followedThrough: false,
          note: 'active plan not found',
        };
        await row.save();
        closed += 1;
        continue;
      }

      const tasksById = new Map();
      for (const week of plan.weeklySchedule || []) {
        for (const t of week.tasks || []) {
          tasksById.set(String(t._id), t);
        }
      }

      const opResults = statusOps.map((op) => {
        const task = tasksById.get(String(op.taskId));
        const statusNow = task && task.progress ? task.progress.status : undefined;
        return { taskId: op.taskId, proposedStatus: op.status, statusNow };
      });

      const followedThrough = opResults.every((r) => r.statusNow === r.proposedStatus);

      row.outcomeSignal = {
        kind: 'plan_ops_followthrough',
        checkedAt,
        ops: opResults,
        followedThrough,
      };
      await row.save();
      closed += 1;
    } catch (err) {
      console.warn('[agentOutcomeClosure] row failed', row._id, err.message);
    }
  }

  return { closed };
}

module.exports = { closeCompassActionOutcomes };
