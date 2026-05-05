const crypto = require('crypto');
const DiagnosticSyllabus = require('../models/DiagnosticSyllabus');
const { generateUploadURL } = require('../config/s3');
const { ocrProcessingQueue } = require('../config/queue');

const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.ms-powerpoint', // ppt
]);
const MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB per spec

function getUserId(req) {
  if (!req.user) return null;
  return req.user._id || req.user.userId || null;
}

exports.initSyllabusUpload = async function initSyllabusUpload(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const { userObjectiveId, contentType, fileSizeBytes } = req.body || {};
  if (!userObjectiveId || !contentType || typeof fileSizeBytes !== 'number') {
    return res.status(400).json({ error: 'userObjectiveId, contentType, fileSizeBytes required' });
  }
  if (!ALLOWED_TYPES.has(contentType)) {
    return res.status(415).json({ error: 'unsupported content type', contentType });
  }
  if (fileSizeBytes <= 0 || fileSizeBytes > MAX_BYTES) {
    return res.status(413).json({ error: 'file too large', maxBytes: MAX_BYTES });
  }

  const ext = contentType.split('/')[1] || 'bin';
  const objectKey = `syllabi/${userId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const { uploadURL, key } = await generateUploadURL(objectKey, contentType);

  // Pre-create the doc with a placeholder contentHash so we can return its id immediately.
  // The hash is replaced on complete. Placeholder is unique per upload to satisfy the
  // unique index on contentHash.
  const placeholderHash = `pending:${objectKey}`;
  const doc = new DiagnosticSyllabus({
    userId,
    userObjectiveId,
    s3Key: key,
    contentType,
    fileSizeBytes,
    contentHash: placeholderHash,
    extractionStatus: 'pending',
  });
  await doc.save();

  return res.status(200).json({
    syllabusId: doc._id,
    uploadUrl: uploadURL,
    s3Key: key,
  });
};

exports.completeSyllabusUpload = async function completeSyllabusUpload(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const { id } = req.params;
  const { contentHash } = req.body || {};
  if (!contentHash) return res.status(400).json({ error: 'contentHash required' });

  // Cache lookup: if another user already extracted this exact file, mark as a cache reuse.
  const cached = await DiagnosticSyllabus.findOne({
    contentHash,
    extractionStatus: 'completed',
  });

  const updated = await DiagnosticSyllabus.findOneAndUpdate(
    { _id: id, userId },
    {
      $set: {
        contentHash,
        extractionStatus: cached ? 'completed' : 'processing',
        ...(cached
          ? {
              extractedText: cached.extractedText,
              extractedTopics: cached.extractedTopics,
              pageCount: cached.pageCount,
              reusedFromHash: cached.contentHash,
              completedAt: new Date(),
            }
          : {}),
      },
    },
    { new: true }
  );
  if (!updated) return res.status(404).json({ error: 'syllabus not found' });

  if (!cached) {
    await ocrProcessingQueue.add('extract-syllabus', {
      syllabusId: String(updated._id),
      userId: String(userId),
      s3Key: updated.s3Key,
      contentType: updated.contentType,
    });
  }

  return res.status(200).json({
    status: updated.extractionStatus,
    cacheHit: Boolean(cached),
  });
};

exports.getSyllabusStatus = async function getSyllabusStatus(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const doc = await DiagnosticSyllabus.findOne({ _id: req.params.id, userId });
  if (!doc) return res.status(404).json({ error: 'syllabus not found' });
  return res.status(200).json({
    status: doc.extractionStatus,
    extractedTopics: doc.extractedTopics || [],
    failureReason: doc.failureReason || null,
  });
};
