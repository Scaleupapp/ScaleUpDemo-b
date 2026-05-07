/**
 * adminTrainingSignalService — collects admin decisions on diagnostic questions
 * and periodically exports few-shot examples for improving questionValidatorService.
 *
 * Spec §5.5: no auto-prompt-rewrite. Export is written to disk; the admin folds
 * the examples into the validator prompt manually during the next iteration.
 *
 * Export threshold: every 100 decisions triggers an export file write.
 * exportFewShotExamples writes up to 20 approve + 20 reject samples.
 */

const fs   = require('fs');
const path = require('path');

const AdminQuestionDecision  = require('../../models/AdminQuestionDecision');
const DiagnosticQuestionBank = require('../../models/DiagnosticQuestionBank');

const EXPORT_THRESHOLD = 100;
const EXPORT_DIR = path.resolve(__dirname, '../../../docs/training-signals');

// ---------------------------------------------------------------------------
// recordDecision
// Called after every admin action (approve/edit/reject).
// Returns { exported: bool, total: number }.
// ---------------------------------------------------------------------------
async function recordDecision(decision) {
  const total = await AdminQuestionDecision.countDocuments();

  // Export when we cross a multiple-of-threshold boundary
  const exported = total > 0 && total % EXPORT_THRESHOLD === 0;
  if (exported) {
    try {
      await exportFewShotExamples();
    } catch (err) {
      console.warn('[adminTrainingSignalService] export failed:', err.message);
    }
  }

  return { exported, total };
}

// ---------------------------------------------------------------------------
// exportFewShotExamples
// Writes docs/training-signals/validator-fewshot-{stamp}.json with
// up to 20 approve + 20 reject examples.
// ---------------------------------------------------------------------------
async function exportFewShotExamples() {
  // Ensure output directory exists
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const [approves, rejects] = await Promise.all([
    AdminQuestionDecision.find({ action: { $in: ['approve', 'edit'] } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    AdminQuestionDecision.find({ action: 'reject' })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
  ]);

  // Enrich with question text + options
  const enrich = async (decisions) => {
    const enriched = [];
    for (const d of decisions) {
      let questionData = null;
      try {
        questionData = await DiagnosticQuestionBank.findById(d.questionId)
          .select('questionText options correctAnswer')
          .lean();
      } catch {}
      enriched.push({
        questionText:      questionData?.questionText  || null,
        options:           questionData?.options        || null,
        correctAnswer:     questionData?.correctAnswer  || null,
        validatorScore:    d.validatorScore,
        validatorCritique: d.validatorCritique,
        adminAction:       d.action,
        adminReason:       d.reason || null,
        decidedAt:         d.createdAt,
      });
    }
    return enriched;
  };

  const [approveExamples, rejectExamples] = await Promise.all([
    enrich(approves),
    enrich(rejects),
  ]);

  const stamp    = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `validator-fewshot-${stamp}.json`;
  const filepath = path.join(EXPORT_DIR, filename);

  const payload = {
    exportedAt:      new Date().toISOString(),
    approveExamples,
    rejectExamples,
    note: 'Review and fold into questionValidatorService.js prompt. No auto-rewrite per spec §5.5.',
  };

  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[adminTrainingSignalService] Exported few-shot examples to ${filepath}`);

  return filepath;
}

module.exports = { recordDecision, exportFewShotExamples };
