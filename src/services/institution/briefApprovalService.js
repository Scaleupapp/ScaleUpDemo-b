'use strict';

/**
 * briefApprovalService — closes an intervention brief's AgentDecision row via
 * TPO approval (Plan 4, Task 3).
 *
 * interventionAgentService only ever writes a PENDING 'brief' row — nothing
 * is sent to a student until a tpo_head approves some or all of the brief's
 * clusters here. Approving a cluster fires its proposedAction (today always
 * `notify_students`) to every studentId in that cluster via
 * notificationService.createInApp, per-student try/catch so one bad
 * notification never blocks the rest of the batch or the row's closure.
 *
 * Full-set approval closes the row 'accepted'; a subset closes it 'adjusted'
 * with adjustmentDiff.approvedClusterKeys — the same accepted/adjusted
 * vocabulary agentDecisionService.respond() uses elsewhere. Briefs close
 * through this dedicated path rather than respond() because a brief's
 * execution semantics (per-cluster notify fan-out, subset selection) don't
 * fit respond()'s single-action-kind dispatch.
 *
 * Validation runs BEFORE any execution (unknown cluster key rejects the
 * whole call with zero notifications sent) — same "validate everything, then
 * apply" convention as agentDecisionService.applyPlanOps.
 *
 * All functions take an optional `deps` for test injection (repo convention:
 * zero network/DB in tests).
 */

function defaultDeps() {
  return {
    AgentDecision: require('../../models/AgentDecision'),
    notificationService: require('../notificationService'),
  };
}

/**
 * approveBrief({ decisionId, institutionId, actorInstitutionUserId, clusterKeys }, deps)
 *   -> Promise<{ executed: { notified }, status }>
 */
async function approveBrief({ decisionId, institutionId, actorInstitutionUserId, clusterKeys }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };

  const row = await d.AgentDecision.findOne({
    _id: decisionId,
    agentId: 'intervention',
    institutionId,
  });
  if (!row) throw new Error('brief not found');

  if (row.status !== 'pending') {
    throw new Error(`brief already ${row.status}`);
  }

  const keys = Array.isArray(clusterKeys) ? clusterKeys : [];
  if (!keys.length) throw new Error('clusterKeys is required');

  const clusters = (row.action && row.action.clusters) || [];
  const clusterByKey = new Map(clusters.map((c) => [c.key, c]));

  // Validate every requested key exists on the row BEFORE executing any
  // notification — one bad key must never leave a partially-notified brief.
  for (const key of keys) {
    if (!clusterByKey.has(key)) {
      throw new Error(`unsupported cluster key: ${key}`);
    }
  }

  const approvedKeys = [...new Set(keys)];
  const allKeys = clusters.map((c) => c.key);
  const isFullSet = allKeys.length === approvedKeys.length && allKeys.every((k) => approvedKeys.includes(k));
  const finalStatus = isFullSet ? 'accepted' : 'adjusted';

  // Atomic claim BEFORE any notification fires: flips status pending ->
  // finalStatus ONLY if the row is still pending, via a direct $set update
  // (dot-path 'contextSnapshot.approvedBy' so the write can't clobber the
  // rest of contextSnapshot — no markModified/save race needed here since
  // this is an atomic update query, not an in-memory mutation).
  //
  // Ordering tradeoff, deliberate: claim-then-notify means a crash mid-notify
  // loop leaves some students un-notified for an already-claimed (closed)
  // brief — under-notify. That is preferred over notify-then-claim, which
  // would let a double-submit fan out the same notifications twice
  // (over-notify / spam) before either request closes the row.
  const setFields = {
    status: finalStatus,
    respondedAt: new Date(),
    'contextSnapshot.approvedBy': actorInstitutionUserId,
  };
  if (!isFullSet) setFields.adjustmentDiff = { approvedClusterKeys: approvedKeys };

  const claimed = await d.AgentDecision.findOneAndUpdate(
    { _id: decisionId, agentId: 'intervention', institutionId, status: 'pending' },
    { $set: setFields },
    { new: true }
  );
  if (!claimed) {
    throw new Error('brief already resolved');
  }

  let notified = 0;
  for (const key of approvedKeys) {
    const cluster = clusterByKey.get(key);
    const payload = (cluster.proposedAction && cluster.proposedAction.payload) || {};
    const studentIds = cluster.studentIds || [];
    for (const studentId of studentIds) {
      try {
        await d.notificationService.createInApp(studentId, {
          type: 'cohort_intervention',
          title: payload.title,
          message: payload.message,
          deepLink: null,
        });
        notified += 1;
      } catch (err) {
        console.warn('[briefApprovalService] notify failed', decisionId, key, studentId, err && err.message);
      }
    }
  }

  return { executed: { notified }, status: claimed.status };
}

module.exports = { approveBrief };
