'use strict';

/**
 * assessmentReportService.js
 *
 * Pure, injectable functions for TPO granular analytics.
 * No direct require() of mongoose models — deps are always injected.
 */

/**
 * CSV-escape a single field value.
 * Fields containing comma, double-quote, newline (\n), or carriage return (\r)
 * are wrapped in double-quotes with internal double-quotes doubled.
 * All other values are output as-is.
 *
 * @param {*} val
 * @returns {string}
 */
function escapeCsvField(val) {
  const str = val == null ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Extract a competency/dimension value from a session result's raw object.
 * Handles all four engine shapes:
 *   - mcq:       raw.competencyBreakdown  [{ competency, percentage }]
 *   - interview:  raw.dimensions          { [dim]: { score } }
 *   - capstone:   raw.dimension_scores    { [dim]: number }
 *   - drill:      raw.rubric_breakdown    [{ dimension, score }]
 *
 * @param {object|null} raw
 * @param {string} col  Column / dimension name to look up
 * @returns {number|string} The score/percentage number, or '' if not found
 */
function extractCompetencyValue(raw, col) {
  if (!raw) return '';
  // mcq competencyBreakdown
  if (Array.isArray(raw.competencyBreakdown)) {
    const entry = raw.competencyBreakdown.find((e) => e && e.competency === col);
    if (entry && typeof entry.percentage === 'number') return entry.percentage;
  }
  // interview dimensions
  if (raw.dimensions && typeof raw.dimensions === 'object') {
    const dim = raw.dimensions[col];
    if (dim && typeof dim.score === 'number') return dim.score;
  }
  // capstone dimension_scores
  if (raw.dimension_scores && typeof raw.dimension_scores === 'object') {
    const val = raw.dimension_scores[col];
    if (typeof val === 'number') return val;
  }
  // drill rubric_breakdown
  if (Array.isArray(raw.rubric_breakdown)) {
    const entry = raw.rubric_breakdown.find((e) => e && e.dimension === col);
    if (entry && typeof entry.score === 'number') return entry.score;
  }
  return '';
}

/**
 * Fetch all AssessmentSession docs for an assessment, then batch-resolve
 * enrollment (→ rollNumber) and user (→ name) in two parallel queries.
 *
 * @param {*}  assessmentId
 * @param {{ revealScores: boolean, cohortId?: string }} opts
 * @param {{ AssessmentSession, InstitutionEnrollment, User }} deps
 * @returns {Promise<Array>}
 */
async function buildSessionRows(assessmentId, { revealScores, cohortId }, deps) {
  const { AssessmentSession, InstitutionEnrollment, User } = deps;

  // 1. Fetch all sessions for the assessment
  const sessionsQuery = AssessmentSession.find({ assessmentId });
  const sessions = typeof sessionsQuery.lean === 'function'
    ? await sessionsQuery.lean()
    : await sessionsQuery;

  if (!sessions.length) return [];

  const userIds = sessions.map((s) => s.userId);

  // 2. Build enrollment filter — scope to cohortId when provided to avoid
  //    cross-cohort roll-number collisions.
  const enrollmentFilter = { userId: { $in: userIds } };
  if (cohortId) enrollmentFilter.cohortId = cohortId;

  // 3. Batch fetch enrollments and users in parallel (not sequential)
  const enrollmentsQuery = InstitutionEnrollment.find(enrollmentFilter);
  const usersQuery = User.find({ _id: { $in: userIds } }, { firstName: 1, lastName: 1 });

  const [enrollments, users] = await Promise.all([
    (typeof enrollmentsQuery.lean === 'function' ? enrollmentsQuery.lean() : enrollmentsQuery),
    (typeof usersQuery.lean === 'function' ? usersQuery.lean() : usersQuery),
  ]);

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

    // Competency columns — look up value from row.raw across all engine shapes
    for (const col of competencyColumns) {
      cells.push(escapeCsvField(String(extractCompetencyValue(row.raw, col))));
    }

    lines.push(cells.join(','));
  }

  return lines.join('\n');
}

module.exports = { buildSessionRows, toCsv, extractCompetencyValue };
