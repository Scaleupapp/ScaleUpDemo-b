'use strict';

/**
 * activationAgentService — the invite-activation agent (#10).
 *
 * Daily, per cohort with outstanding ('invited') PendingStudents: re-sends the
 * claim invite to students who haven't claimed their seat yet, capped so a
 * student is never nudged forever. Re-sends go through inviteService's real
 * `sendInvites` — this service never duplicates the email/SMS templating, it
 * only decides WHO is due a re-send and persists the reminder counters.
 *
 * A cohort with any successful re-sends this run gets exactly one AgentDecision
 * ledger row ('nudge') summarising the batch — one row per cohort, not one per
 * student, so the ledger stays a readable audit trail instead of student-level
 * noise. Zero-reminded cohorts (nothing due, or everything exhausted) write
 * nothing.
 *
 * All functions take an optional `deps` for test injection (repo convention:
 * zero network/DB in tests).
 */

const DEFAULT_MAX_REMINDERS = 3;
const DEFAULT_REMINDER_GAP_DAYS = 3;

function getMaxReminders() {
  const v = parseInt(process.env.ACTIVATION_MAX_REMINDERS, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_REMINDERS;
}

function getReminderGapDays() {
  const v = parseInt(process.env.ACTIVATION_REMINDER_GAP_DAYS, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_REMINDER_GAP_DAYS;
}

/**
 * Every (institutionId, cohortId) pair with at least one outstanding invite
 * ('invited' status) — the candidate population runDaily iterates. A cohort
 * with zero outstanding invites (everyone claimed, or nothing invited yet)
 * never appears here, so runDaily never even builds a reminder query for it.
 */
async function listCandidateCohorts(deps) {
  const pairs = await deps.PendingStudent.aggregate([
    { $match: { status: 'invited' } },
    { $group: { _id: { institutionId: '$institutionId', cohortId: '$cohortId' } } },
  ]);
  return (pairs || []).map((p) => ({ institutionId: p._id.institutionId, cohortId: p._id.cohortId }));
}

function defaultDeps() {
  return {
    PendingStudent: require('../../models/PendingStudent'),
    Institution: require('../../models/Institution'),
    AgentDecision: require('../../models/AgentDecision'),
    sendInvites: require('./inviteService').sendInvites,
    record: require('../agentDecisionService').record,
    isAgentEnabled: require('../../config/agentFlags').isAgentEnabled,
    listCandidateCohorts,
    now: () => new Date(),
  };
}

/**
 * The reminder-eligibility query, built as a real Mongo filter (not a
 * post-hoc JS filter over every invited student) so a large cohort's find()
 * only ever returns rows actually due a nudge:
 *   - status 'invited' (claimed/expired/pending students are never nudged)
 *   - remindersSent < MAX (a student AT the cap is excluded — "exhausted",
 *     never queried again until a human intervenes some other way)
 *   - the eligibility timestamp is GAP days old OR OLDER.
 *
 * Eligibility timestamp: lastReminderAt when the student has been reminded
 * before, else the invite-send timestamp. PendingStudent has no dedicated
 * "invited at" field — sendInvites flips status -> 'invited' in the same
 * request that creates/updates the row (rosterService.commitRoster followed
 * immediately by inviteService.sendInvites), so `createdAt` is that moment
 * closely enough to serve as the fallback.
 *
 * Boundary is INCLUSIVE ($lte): a student due reminding EXACTLY GAP days ago
 * is eligible now, not tomorrow — same convention interventionAgentService
 * uses for its window boundaries (see INACTIVE_WINDOW_DAYS there).
 */
function buildCandidateFilter({ institutionId, cohortId, cutoff, maxReminders }) {
  return {
    institutionId,
    cohortId,
    status: 'invited',
    remindersSent: { $lt: maxReminders },
    $or: [
      { lastReminderAt: { $lte: cutoff } },
      { lastReminderAt: null, createdAt: { $lte: cutoff } },
    ],
  };
}

/**
 * processCohort — re-sends to every eligible candidate in one cohort, updates
 * their counters, and records the batch ledger row if any went out.
 * Returns { stats, recorded }.
 */
async function processCohort({ institutionId, cohortId }, d, now) {
  const maxReminders = getMaxReminders();
  const reminderGapDays = getReminderGapDays();
  const cutoff = new Date(now.getTime() - reminderGapDays * 24 * 60 * 60 * 1000);

  const filter = buildCandidateFilter({ institutionId, cohortId, cutoff, maxReminders });
  const candidates = (await d.PendingStudent.find(filter)) || [];

  let institutionName = 'Your Institution';
  try {
    const institution = await d.Institution.findById(institutionId);
    if (institution && institution.name) institutionName = institution.name;
  } catch (_) {
    // best-effort — a lookup failure never blocks the batch
  }
  const baseLink = process.env.STUDENT_APP_JOIN_URL || 'https://placement.scaleupapp.club/join';

  let reminded = 0;
  let invalid = 0;
  for (const candidate of candidates) {
    try {
      const result = await d.sendInvites([candidate], { institutionName, baseLink });
      if (result && Array.isArray(result.failures) && result.failures.length > 0) {
        invalid += 1;
        continue;
      }
      candidate.remindersSent = (candidate.remindersSent || 0) + 1;
      candidate.lastReminderAt = now;
      await candidate.save();
      reminded += 1;
    } catch (_) {
      // one bad send never stops the batch
      invalid += 1;
    }
  }

  // Snapshot counts AFTER the batch, so `exhausted` reflects any candidate
  // this very run just pushed to remindersSent === maxReminders.
  const [invitedCount, claimedCount, exhaustedCount] = await Promise.all([
    d.PendingStudent.countDocuments({ institutionId, cohortId, status: 'invited' }),
    d.PendingStudent.countDocuments({ institutionId, cohortId, status: 'claimed' }),
    d.PendingStudent.countDocuments({ institutionId, cohortId, status: 'invited', remindersSent: { $gte: maxReminders } }),
  ]);

  const stats = { invited: invitedCount, claimed: claimedCount, reminded, exhausted: exhaustedCount, invalid };

  let recorded = false;
  if (reminded >= 1) {
    await d.record({
      agentId: 'activation',
      decisionType: 'nudge',
      institutionId,
      cohortId,
      action: { kind: 'activation_reminder_batch', stats, reminderGapDays, maxReminders },
      promptVersion: 'activation-v1',
    }, d);
    recorded = true;
  }

  return { stats, recorded };
}

/**
 * runDaily(deps) -> Promise<{ cohorts, reminded }>
 *
 * Flag-gated (zero DB reads when off). For every cohort with an outstanding
 * invite, re-sends to everyone due a nudge, capped per student. `cohorts` is
 * the count of cohorts that actually got a reminder batch (ledger row
 * written); `reminded` is the total number of students re-sent to across all
 * cohorts this run. Per-cohort try/catch — one cohort's failure never blocks
 * the rest of the run.
 */
async function runDaily(deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!d.isAgentEnabled('activation')) return { cohorts: 0, reminded: 0 };

  const cohorts = await d.listCandidateCohorts(d);
  const now = (d.now && d.now()) || new Date();

  let cohortsRecorded = 0;
  let totalReminded = 0;

  for (const { institutionId, cohortId } of cohorts) {
    try {
      const { stats, recorded } = await processCohort({ institutionId, cohortId }, d, now);
      totalReminded += stats.reminded;
      if (recorded) cohortsRecorded += 1;
    } catch (err) {
      console.warn('[activationAgent] cohort batch failed', institutionId, cohortId, err && err.message);
    }
  }

  return { cohorts: cohortsRecorded, reminded: totalReminded };
}

/**
 * getFunnel({ institutionId, cohortId }, deps) -> Promise<{ invited, claimed, claimRate, exhausted, lastBatch }>
 *
 * Read-only snapshot for the web panel. claimRate = claimed / (invited +
 * claimed) — 0 when there's nothing to divide by (no invites sent yet).
 * lastBatch is the most recent activation ledger row's action.stats, or null
 * when this cohort has never had a reminder batch.
 */
async function getFunnel({ institutionId, cohortId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const maxReminders = getMaxReminders();

  const [invited, claimed, exhausted, lastRow] = await Promise.all([
    d.PendingStudent.countDocuments({ institutionId, cohortId, status: 'invited' }),
    d.PendingStudent.countDocuments({ institutionId, cohortId, status: 'claimed' }),
    d.PendingStudent.countDocuments({ institutionId, cohortId, status: 'invited', remindersSent: { $gte: maxReminders } }),
    d.AgentDecision.findOne({ agentId: 'activation', institutionId, cohortId }).sort({ createdAt: -1 }),
  ]);

  const total = invited + claimed;
  const claimRate = total > 0 ? claimed / total : 0;
  const lastBatch = (lastRow && lastRow.action && lastRow.action.stats) || null;

  return { invited, claimed, claimRate, exhausted, lastBatch };
}

module.exports = {
  runDaily,
  getFunnel,
  _helpers: {
    buildCandidateFilter,
    listCandidateCohorts,
    processCohort,
    getMaxReminders,
    getReminderGapDays,
    DEFAULT_MAX_REMINDERS,
    DEFAULT_REMINDER_GAP_DAYS,
  },
};
