'use strict';
/**
 * Assessment Sources routes
 *
 * POST   /assessment-sources        — TPO role; upload a syllabus/PDF/image
 * GET    /assessment-sources        — any institution role; list sources
 * GET    /assessment-sources/:id    — any institution role; get single source detail
 *
 * Uses a router._deps seam so tests can inject stubs without real S3 or DB.
 */
const express = require('express');
const multer = require('multer');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const mongoose = require('mongoose');

const router = express.Router();
router._deps = null;

// ── Allowed upload MIME types ─────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
]);

/**
 * Returns true if the given mimetype is allowed for assessment source uploads.
 * Exported so unit tests can verify the allow-list without exercising multer.
 *
 * @param {string} mimetype
 * @returns {boolean}
 */
function isAllowedMimeType(mimetype) {
  return ALLOWED_MIME_TYPES.has(mimetype);
}

// ── Multer: 20 MB in-memory, allow-listed MIME types only ────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: function (_req, file, cb) {
    if (isAllowedMimeType(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error('BAD_FILE_TYPE');
      err.code = 'BAD_FILE_TYPE';
      cb(err, false);
    }
  },
});

// ── Dependency getters ───────────────────────────────────────────────────────

function getAssessmentSource() {
  return (router._deps && router._deps.AssessmentSource) ||
    require('../../models/AssessmentSource');
}

function getUploadBuffer() {
  return (router._deps && router._deps.uploadBuffer) ||
    require('../../config/s3').uploadBuffer;
}

function getRunExtraction() {
  return (router._deps && router._deps.runExtraction) ||
    require('../../services/institution/assessment/sourceExtractionService').runExtraction;
}

// ── POST /assessment-sources ─────────────────────────────────────────────────

router.post(
  '/assessment-sources',
  institutionAuth,
  requireInstitutionRole('tpo_head', 'tpo_coordinator'),
  upload.single('file'),
  async (req, res) => {
    try {
      const scope = institutionScope(req);
      const { cohortId } = req.body || {};
      const file = req.file;

      if (!file) {
        return res.status(400).json({ success: false, code: 'NO_FILE', message: 'A file upload is required.' });
      }

      const AssessmentSource = getAssessmentSource();
      const uploadBuffer = getUploadBuffer();
      const runExtraction = getRunExtraction();

      // Create a placeholder to get an _id for the S3 key
      const sourceId = new mongoose.Types.ObjectId();
      const s3Key = `assessment-sources/${scope.institutionId}/${sourceId}`;

      // Upload to S3
      await uploadBuffer(s3Key, file.buffer, file.mimetype);

      // Create DB record
      const source = await AssessmentSource.create({
        _id: sourceId,
        institutionId: scope.institutionId,
        cohortId: cohortId || undefined,
        uploadedBy: req.institution.institutionUserId,
        filename: file.originalname,
        mimeType: file.mimetype,
        s3Key,
        status: 'uploaded',
      });

      // Fire-and-forget extraction
      runExtraction(source._id).catch((err) => {
        console.warn('[assessmentSources:runExtraction] background extraction failed:', err.message);
      });

      return res.status(201).json({
        success: true,
        data: { sourceId: String(source._id), status: source.status },
      });
    } catch (err) {
      console.error('[institution/assessmentSources:create]', err.message);
      return res.status(500).json({ success: false, message: 'Could not upload assessment source.' });
    }
  }
);

// ── GET /assessment-sources ───────────────────────────────────────────────────

router.get(
  '/assessment-sources',
  institutionAuth,
  async (req, res) => {
    try {
      const scope = institutionScope(req);
      const { cohortId } = req.query || {};

      const AssessmentSource = getAssessmentSource();

      const filter = { institutionId: scope.institutionId };
      if (cohortId) filter.cohortId = cohortId;

      const sources = await AssessmentSource.find(filter)
        .select('_id filename status extractedTopics createdAt')
        .sort({ createdAt: -1 })
        .lean();

      return res.json({
        success: true,
        data: sources.map((s) => ({
          id: String(s._id),
          filename: s.filename,
          status: s.status,
          topicsCount: Array.isArray(s.extractedTopics) ? s.extractedTopics.length : 0,
          createdAt: s.createdAt,
        })),
      });
    } catch (err) {
      console.error('[institution/assessmentSources:list]', err.message);
      return res.status(500).json({ success: false, message: 'Could not list assessment sources.' });
    }
  }
);

// ── GET /assessment-sources/:id ───────────────────────────────────────────────

router.get(
  '/assessment-sources/:id',
  institutionAuth,
  async (req, res) => {
    try {
      const scope = institutionScope(req);
      const AssessmentSource = getAssessmentSource();

      const source = await AssessmentSource.findOne({
        _id: req.params.id,
        institutionId: scope.institutionId,
      }).lean();

      if (!source) {
        return res.status(404).json({ success: false, message: 'Assessment source not found.' });
      }

      return res.json({
        success: true,
        data: {
          id: String(source._id),
          status: source.status,
          filename: source.filename,
          extractedTopics: source.extractedTopics || [],
          error: source.error || null,
        },
      });
    } catch (err) {
      console.error('[institution/assessmentSources:get]', err.message);
      return res.status(500).json({ success: false, message: 'Could not retrieve assessment source.' });
    }
  }
);

// ── Multer error handler ─────────────────────────────────────────────────────
// Catches fileFilter rejections (BAD_FILE_TYPE) and size-limit errors before
// they bubble up to the generic 500 handler.
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  if (err && (err.code === 'BAD_FILE_TYPE' || err.message === 'BAD_FILE_TYPE')) {
    return res.status(400).json({ success: false, code: 'BAD_FILE_TYPE', message: 'File type not allowed.' });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, code: 'FILE_TOO_LARGE', message: 'File exceeds the 20 MB size limit.' });
  }
  console.error('[institution/assessmentSources]', err && err.message);
  return res.status(500).json({ success: false, message: 'Upload error.' });
});

module.exports = router;
module.exports.isAllowedMimeType = isAllowedMimeType;
