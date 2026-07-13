'use strict';

/**
 * authorAgentClosure — closes the author agent's pending AgentDecision row
 * against the assessment's REAL lifecycle (Plan 3, Task 3).
 *
 * Tasks 1-2 record a `pending` AgentDecision row (agentId 'author_agent',
 * action.kind 'assessment_authoring_run', action.assessmentId as String)
 * whenever the author agent runs, but nothing ever closes it — there is no
 * explicit "accept this run" UI. The human signal instead lives in what the
 * TPO actually does with the authored assessment: releasing it to students
 * is acceptance (with or without edits along the way); deleting it is
 * rejection. This module reads that signal off the lifecycle events the
 * routes/services already fire and turns it into a status transition on the
 * latest pending row.
 *
 * editedQuestionCount simplification (read, not invented): there is no
 * edit-tracking infrastructure on Assessment/AgentDecision today — no
 * per-question edit counter, and the QA-passed pool that authorMcq freezes
 * onto config.mcq.questions has no "edited since authoring" flag. Building
 * that infrastructure is out of scope for this task, so every current call
 * site passes editedQuestionCount: 0 (release → 'accepted'). The 'adjusted'
 * branch below is real and tested — it activates the moment a future task
 * threads a real count through.
 *
 * All functions take an optional `deps` for test injection (repo convention:
 * zero network/DB in tests).
 */

function defaultDeps() {
  return {
    AgentDecision: require('../../../models/AgentDecision'),
    isAgentEnabled: require('../../../config/agentFlags').isAgentEnabled,
  };
}

/**
 * closeOnLifecycle({ assessmentId, event, editedQuestionCount }, deps)
 *   -> Promise<{ closed: boolean }>
 *
 * event: 'released' | 'deleted'. Flag-gated (author_agent) and silent when
 * there is no pending row to close — this is a best-effort closure hook,
 * never a required step of the lifecycle action that triggers it.
 */
async function closeOnLifecycle({ assessmentId, event, editedQuestionCount = 0 }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };

  if (!d.isAgentEnabled('author_agent')) return { closed: false };

  if (!['released', 'deleted'].includes(event)) {
    throw new Error(`unsupported event: ${event}`);
  }

  const row = await d.AgentDecision.findOne({
    agentId: 'author_agent',
    status: 'pending',
    'action.assessmentId': String(assessmentId),
  }).sort({ createdAt: -1 });

  if (!row) return { closed: false };

  if (event === 'deleted') {
    row.status = 'rejected';
  } else if (editedQuestionCount > 0) {
    row.status = 'adjusted';
    row.adjustmentDiff = { editedQuestionCount };
  } else {
    row.status = 'accepted';
  }

  row.respondedAt = new Date();
  await row.save();

  return { closed: true };
}

module.exports = { closeOnLifecycle };
