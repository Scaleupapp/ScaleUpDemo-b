const crypto = require('crypto');
const { generateUploadURL, initiateMultipartUpload, getPartUploadURL, completeMultipartUpload, abortMultipartUpload } = require('../config/s3');
const Content = require('../models/Content');
const { contentProcessingQueue } = require('../config/queue');
const ApiError = require('../utils/apiError');

const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024; // 4 GB

class UploadService {

  async requestUpload({ creatorId, fileName, fileType, fileSize }) {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedTypes.includes(fileType)) throw new ApiError(400, 'File type not allowed');
    if (fileSize > MAX_FILE_SIZE) throw new ApiError(400, 'File too large. Max 4GB.');

    const ext = fileName.split('.').pop();
    const key = `content/${creatorId}/${crypto.randomUUID()}.${ext}`;
    const uploadURL = await generateUploadURL(key, fileType, 21600); // 6 hour expiry

    return { uploadURL, key, expiresIn: 21600 };
  }

  // --- S3 Multipart Upload ---

  async initiateMultipart({ creatorId, fileName, fileType, fileSize, partSize }) {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedTypes.includes(fileType)) throw new ApiError(400, 'File type not allowed');
    if (fileSize > MAX_FILE_SIZE) throw new ApiError(400, 'File too large. Max 4GB.');

    const ext = fileName.split('.').pop();
    const key = `content/${creatorId}/${crypto.randomUUID()}.${ext}`;
    const uploadId = await initiateMultipartUpload(key, fileType);

    const totalParts = Math.ceil(fileSize / partSize);
    const partURLs = [];
    for (let i = 1; i <= totalParts; i++) {
      const url = await getPartUploadURL(key, uploadId, i);
      partURLs.push({ partNumber: i, url });
    }

    return { key, uploadId, totalParts, partURLs };
  }

  async completeMultipart({ key, uploadId, parts }) {
    await completeMultipartUpload(key, uploadId, parts);
    return { key };
  }

  async abortMultipart({ key, uploadId }) {
    await abortMultipartUpload(key, uploadId);
    return { success: true };
  }

  // --- Content Registration ---

  async completeUpload({ creatorId, key, title, description, contentType, domain, topics, tags, difficulty }) {
    const contentURL = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

    const content = await Content.create({
      creatorId, title, description, contentType,
      contentURL, domain, topics, tags, difficulty,
      sourceType: 'original',
      status: 'processing', aiStatus: 'pending',
    });

    await contentProcessingQueue.add('process', { contentId: content._id });
    return content;
  }
}

module.exports = new UploadService();
