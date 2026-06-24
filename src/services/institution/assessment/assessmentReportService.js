'use strict';

/**
 * assessmentReportService.js
 *
 * Pure, injectable functions for TPO granular analytics.
 * No direct require() of mongoose models — deps are always injected.
 */

/**
 * CSV-escape a single field value.
 * Fields containing comma, double-quote, or newline are wrapped in double-quotes
 * with internal double-quotes doubled. All other values are output as-is.
 *
 * @param {*} val
 * @returns {string}
 */
function escapeCsvField(val) {
  const str = val == null ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Fetch all AssessmentSession docs for an assessment, then batch-resolve
 * enrollment (→ rollNumber) and user (→ name) in two single queries.
 *
 * @param {*}  assessmentId
 * @param {{ revealScores: boolean }} opts
 * @param {{ AssessmentSession, InstitutionEnrollment, User }} deps
 * @returns {Promise<Array>}
 */
async function buildSessionRows(assessmentId, { revealScores }, deps) {
  const { AssessmentSession, InstitutionEnrollment, User } = deps;

  // 1. Fetch all sessions for the assessment
  const sessionsQuery = AssessmentSession.find({ assessmentId });
  const sessions = typeof sessionsQuery.lean === 'function'
    ? await sessionsQuery.lean()
    : await sessionsQuery;

  if (!sessions.length) return [];

  const userIds = sessions.map((s) => s.userId);

  // 2. Batch fetch enrollments — we need assessmentId's cohortId but we don't
  //    have it here; the spec says find by userId $in, relying on the caller
  //    to pass the right assessment._id. Enrollments are looked up across the
  //    institution; rollNumber is typically unique per user anyway.
  //    (The monitor route already has cohortId — but the service only receives
  //    assessmentId. We query without cohortId filter here; for the CSV route
  //    the assessment._id ties us to the right cohort via AssessmentSession.)
  const enrollmentsQuery = InstitutionEnrollment.find({ userId: { $in: userIds } });
  const enrollments = typeof enrollmentsQuery.lean === 'function'
    ? await enrollmentsQuery.lean()
    : await enrollmentsQuery;

  // 3. Batch fetch users (only firstName + lastName)
  const usersQuery = User.find({ _id: { $in: userIds } }, { firstName: 1, lastName: 1 });
  const users = typeof usersQuery.lean === 'function'
    ? await usersQuery.lean()
    : await usersQuery;

  // 4. Build lookup maps (keyed by stringified userId / _id)
  const enrollmentByUserId = {};
  for (const e of enrollments) {
    enrollmentByUserId[String(e.userId)] = e;
  }

  const userById = {};
  for (const u of users) {
    userById[String(u._id)] = u;
  }

  // 5. Map to row objects
  return sessions.map((s) => {
    const uid = String(s.userId);
    const enrollment = enrollmentByUserId[uid];
    const user = userById[uid];

    let name = '';
    if (user) {
      const parts = [user.firstName, user.lastName].filter(Boolean);
      name = parts.join(' ').trim();
    }

    const rollNumber = (enrollment && enrollment.rollNumber) ? enrollment.rollNumber : '';

    const result = s.result || {};
    const score = (revealScores && typeof result.score === 'number') ? result.score : null;

    return {
      userId: uid,
      name,
      rollNumber,
      status: s.status,
      startedAt: s.startedAt || null,
      submittedAt: s.submittedAt || null,
      gradedAt: s.gradedAt || null,
      score,
      integrity: result.integrity != null ? result.integrity : null,
      raw: result.raw != null ? result.raw : null,
    };
  });
}

/**
 * Convert an array of session rows to a CSV string.
 *
 * Columns (in order):
 *   rollNumber, name, status, score, integrity, submittedAt, gradedAt,
 *   ...competencyColumns
 *
 * @param {Array}  rows              Output of buildSessionRows
 * @param {string[]} competencyColumns Names from rollup.byCompetency
 * @returns {string} CSV text (header + data rows, separated by \n)
 */
function toCsv(rows, competencyColumns) {
  const fixedHeaders = ['rollNumber', 'name', 'status', 'score', 'integrity', 'submittedAt', 'gradedAt'];
  const allHeaders = [...fixedHeaders, ...competencyColumns];

  const lines = [allHeaders.map(escapeCsvField).join(',')];

  for (const row of rows) {
    const cells = [
      escapeCsvField(row.rollNumber),
      escapeCsvField(row.name),
      escapeCsvField(row.status),
      // score: blank if null
      escapeCsvField(row.score == null ? '' : row.score),
      escapeCsvField(row.integrity == null ? '' : row.integrity),
      // dates: ISO string or ''
      escapeCsvField(row.submittedAt ? new Date(row.submittedAt).toISOString() : ''),
      escapeCsvField(row.gradedAt ? new Date(row.gradedAt).toISOString() : ''),
    ];

    // Competency columns (not in the base row — would need to be pre-joined by caller if needed)
    for (const col of competencyColumns) {
      cells.push(escapeCsvField(''));
    }

    lines.push(cells.join(','));
  }

  return lines.join('\n');
}

module.exports = { buildSessionRows, toCsv };
