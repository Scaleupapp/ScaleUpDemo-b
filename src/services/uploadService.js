const crypto = require('crypto');
const { generateUploadURL } = require('../config/s3');
const Content = require('../models/Content');
const { contentProcessingQueue } = require('../config/queue');
const ApiError = require('../utils/apiError');

class UploadService {

  async requestUpload({ creatorId, fileName, fileType, fileSize }) {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedTypes.includes(fileType)) throw new ApiError(400, 'File type not allowed');
    if (fileSize > 2 * 1024 * 1024 * 1024) throw new ApiError(400, 'File too large. Max 2GB.');

    const ext = fileName.split('.').pop();
    const key = `content/${creatorId}/${crypto.randomUUID()}.${ext}`;
    const uploadURL = await generateUploadURL(key, fileType, 3600);

    return { uploadURL, key, expiresIn: 3600 };
  }

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
