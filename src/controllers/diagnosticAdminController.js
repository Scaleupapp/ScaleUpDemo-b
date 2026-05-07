/**
 * diagnosticAdminController — admin endpoints for reviewing diagnostic questions.
 *
 * All handlers require the adminAuth middleware (Task 12) which gates on
 * role='admin'. The adminTrainingSignalService (Task 14) is loaded lazily
 * inside each handler that needs it, and wrapped in try/catch so a missing
 * or failing training-signal service never breaks the admin action itself.
 */

const DiagnosticQuestionBank = require('../models/DiagnosticQuestionBank');
const AdminQuestionDecision  = require('../models/AdminQuestionDecision');

// ---------------------------------------------------------------------------
// GET /admin/diagnostic-questions/queue
// Returns paginated questions with verificationStatus='flagged_for_review'.
// ---------------------------------------------------------------------------
async function getQueue(req, res) {
  const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip  = (page - 1) * limit;

  const filter = { verificationStatus: 'flagged_for_review' };

  const [questions, total] = await Promise.all([
    DiagnosticQuestionBank.find(filter)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    DiagnosticQuestionBank.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: {
      questions,
      total,
      page,
      pages: Math.ceil(total / limit),
    },
  });
}

// ---------------------------------------------------------------------------
// POST /admin/diagnostic-questions/:id/approve
// ---------------------------------------------------------------------------
async function approve(req, res) {
  const question = await DiagnosticQuestionBank.findById(req.params.id);
  if (!question) return res.status(404).json({ success: false, message: 'Question not found' });

  const prevStatus = question.verificationStatus;

  question.verificationStatus = 'human_verified';
  question.humanReviewedBy    = req.user.userId;
  question.humanReviewedAt    = new Date();
  question.humanReviewNotes   = req.body.reason || '';
  await question.save();

  const decision = await AdminQuestionDecision.create({
    questionId:        question._id,
    adminId:           req.user.userId,
    action:            'approve',
    reason:            req.body.reason,
    validatorScore:    question.validatorScore,
    validatorCritique: question.validatorCritique,
  });

  // Training signal — fire-and-forget, non-blocking
  try {
    const adminTrainingSignalService = require('../services/diagnostic/adminTrainingSignalService');
    await adminTrainingSignalService.recordDecision(decision);
  } catch (err) {
    console.warn('[diagnosticAdminController] training signal recording skipped:', err.message);
  }

  res.json({ success: true, data: { question, decision } });
}

// ---------------------------------------------------------------------------
// POST /admin/diagnostic-questions/:id/edit
// Apply field updates and mark as human_verified.
// ---------------------------------------------------------------------------
async function edit(req, res) {
  const question = await DiagnosticQuestionBank.findById(req.params.id);
  if (!question) return res.status(404).json({ success: false, message: 'Question not found' });

  const allowedFields = ['questionText', 'options', 'correctAnswer', 'explanation', 'difficulty', 'canonicalCompetency'];
  const editDiff = {};

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      editDiff[field] = { before: question[field], after: req.body[field] };
      question[field] = req.body[field];
    }
  }

  question.verificationStatus = 'human_verified';
  question.humanReviewedBy    = req.user.userId;
  question.humanReviewedAt    = new Date();
  question.humanReviewNotes   = req.body.reason || '';
  await question.save();

  const decision = await AdminQuestionDecision.create({
    questionId:        question._id,
    adminId:           req.user.userId,
    action:            'edit',
    reason:            req.body.reason,
    editDiff,
    validatorScore:    question.validatorScore,
    validatorCritique: question.validatorCritique,
  });

  // Training signal
  try {
    const adminTrainingSignalService = require('../services/diagnostic/adminTrainingSignalService');
    await adminTrainingSignalService.recordDecision(decision);
  } catch (err) {
    console.warn('[diagnosticAdminController] training signal recording skipped:', err.message);
  }

  res.json({ success: true, data: { question, decision } });
}

// ---------------------------------------------------------------------------
// POST /admin/diagnostic-questions/:id/reject
// Delete the question, log the decision, optionally enqueue regeneration.
// ---------------------------------------------------------------------------
async function reject(req, res) {
  const question = await DiagnosticQuestionBank.findById(req.params.id);
  if (!question) return res.status(404).json({ success: false, message: 'Question not found' });

  // Snapshot before deletion
  const snapshot = {
    questionId:        question._id,
    adminId:           req.user.userId,
    action:            'reject',
    reason:            req.body.reason,
    validatorScore:    question.validatorScore,
    validatorCritique: question.validatorCritique,
    regenerate:        req.body.regenerate === true,
  };

  await DiagnosticQuestionBank.deleteOne({ _id: question._id });

  const decision = await AdminQuestionDecision.create(snapshot);

  // Training signal
  try {
    const adminTrainingSignalService = require('../services/diagnostic/adminTrainingSignalService');
    await adminTrainingSignalService.recordDecision(decision);
  } catch (err) {
    console.warn('[diagnosticAdminController] training signal recording skipped:', err.message);
  }

  // Optional regeneration enqueue (stub — real queue wiring happens in a later task if needed)
  if (req.body.regenerate === true) {
    console.log(`[diagnosticAdminController] Regeneration requested for competency=${question.canonicalCompetency} difficulty=${question.difficulty}`);
  }

  res.json({ success: true, data: { decision } });
}

// ---------------------------------------------------------------------------
// GET /admin/diagnostic-questions/stats
// Returns queue depth, status distribution, recent decisions, validator pass rate.
// ---------------------------------------------------------------------------
async function getStats(req, res) {
  const [distribution, recentDecisions, validatorScores] = await Promise.all([
    DiagnosticQuestionBank.aggregate([
      { $group: { _id: '$verificationStatus', count: { $sum: 1 } } },
    ]),
    AdminQuestionDecision.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    DiagnosticQuestionBank.find({ validatorScore: { $exists: true } })
      .select('validatorScore')
      .lean(),
  ]);

  const queueDepth = distribution.find(d => d._id === 'flagged_for_review')?.count || 0;

  const validatorPassRate = validatorScores.length > 0
    ? validatorScores.filter(q => q.validatorScore >= 70).length / validatorScores.length
    : null;

  const distMap = {};
  for (const d of distribution) distMap[d._id] = d.count;

  res.json({
    success: true,
    data: {
      queueDepth,
      distribution: distMap,
      recentDecisions,
      validatorPassRate: validatorPassRate !== null ? Math.round(validatorPassRate * 100) / 100 : null,
    },
  });
}

module.exports = { getQueue, approve, edit, reject, getStats };
