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
    InterviewProgram: require('../models/InterviewProgram'),
    InterviewSession: require('../models/InterviewSession'),
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

/**
 * Outcome-closure sweep for interview_coach `session_focus` recommendations
 * (Plan 5 Task 6).
 *
 * Simplification (documented, chosen over the dimension-matched variant the
 * task description offers as an alternative): rather than matching each row
 * to the specific focusHistory entry it produced (action.dimension + nearest
 * focusHistory.at), we look up the user's InterviewProgram directly by
 * userId and ask a coarser, honest question — did the user do ANY graded
 * mock interview after the recommendation fired? A graded session appearing
 * after the row's createdAt is treated as "followed through", regardless of
 * whether it happened to target the exact recommended dimension. This is
 * simpler, avoids brittle history-entry matching (multiple programs, history
 * entries with no exact dimension re-hit), and is honest about what it
 * measures: engagement follow-through, not per-dimension improvement.
 *
 * Sessions are counted "after" the row via `updatedAt` (present on every
 * InterviewSession via schema timestamps) rather than `completedAt`, which
 * can be unset on re-graded or edge-case rows.
 */
async function closeInterviewFocusOutcomes({ olderThanDays = 7 } = {}, deps = {}) {
  const { AgentDecision, InterviewProgram, InterviewSession } = { ...defaultDeps(), ...deps };
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const rows = await AgentDecision.find({
    agentId: 'interview_coach',
    'action.kind': 'session_focus',
    outcomeSignal: null,
    createdAt: { $lt: cutoff },
  }).exec();

  let closed = 0;

  for (const row of rows) {
    try {
      const checkedAt = new Date();
      const program = await InterviewProgram.findOne({ userId: row.userId }).lean();

      if (!program) {
        row.outcomeSignal = {
          kind: 'interview_focus_followthrough',
          checkedAt,
          followedThrough: false,
          sessionsAfter: 0,
          note: 'no program',
        };
        await row.save();
        closed += 1;
        continue;
      }

      const sessionsAfter = await InterviewSession.find({
        _id: { $in: program.sessionIds || [] },
        status: 'evaluated',
        'evaluation.gradeStatus': 'graded',
        updatedAt: { $gt: row.createdAt },
      }).exec();

      const n = sessionsAfter.length;
      row.outcomeSignal = {
        kind: 'interview_focus_followthrough',
        checkedAt,
        followedThrough: n > 0,
        sessionsAfter: n,
      };
      await row.save();
      closed += 1;
    } catch (err) {
      console.warn('[agentOutcomeClosure] interview-focus row failed', row._id, err.message);
    }
  }

  return { closed };
}

module.exports = { closeCompassActionOutcomes, closeInterviewFocusOutcomes };
