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

  const allKeys = clusters.map((c) => c.key);
  const isFullSet = allKeys.length === approvedKeys.length && allKeys.every((k) => approvedKeys.includes(k));

  if (isFullSet) {
    row.status = 'accepted';
  } else {
    row.status = 'adjusted';
    row.adjustmentDiff = { approvedClusterKeys: approvedKeys };
  }
  row.respondedAt = new Date();

  row.contextSnapshot = row.contextSnapshot || {};
  row.contextSnapshot.approvedBy = actorInstitutionUserId;
  // contextSnapshot is Schema.Types.Mixed — Mongoose won't detect an
  // in-place mutation of it, so the approvedBy stamp must be flagged
  // explicitly or it silently never persists.
  row.markModified('contextSnapshot');

  await row.save();

  return { executed: { notified }, status: row.status };
}

module.exports = { approveBrief };
