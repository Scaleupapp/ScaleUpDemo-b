const {
  S3Client, PutObjectCommand, GetObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function generateUploadURL(key, contentType, expiresIn = 3600) {
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, command, { expiresIn });
}

async function uploadStream(key, stream, contentType) {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: stream,
      ContentType: contentType,
    },
    queueSize: 4,
    partSize: 1024 * 1024 * 5, // 5 MB parts
  });
  await upload.done();
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

async function uploadBuffer(key, buffer, contentType, { publicRead = false } = {}) {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  };
  if (publicRead) {
    params.ACL = 'public-read';
  }
  const command = new PutObjectCommand(params);
  await s3.send(command);
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

// --- S3 Multipart Upload helpers ---

async function initiateMultipartUpload(key, contentType) {
  const command = new CreateMultipartUploadCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  const response = await s3.send(command);
  return response.UploadId;
}

async function getPartUploadURL(key, uploadId, partNumber, expiresIn = 21600) {
  const command = new UploadPartCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(s3, command, { expiresIn });
}

async function completeMultipartUpload(key, uploadId, parts) {
  const command = new CompleteMultipartUploadCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.map(p => ({ ETag: p.etag, PartNumber: p.partNumber })),
    },
  });
  return s3.send(command);
}

async function abortMultipartUpload(key, uploadId) {
  const command = new AbortMultipartUploadCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    UploadId: uploadId,
  });
  return s3.send(command);
}

/**
 * Download an object as a Buffer. Returns an empty Buffer if the object
 * doesn't exist — callers (e.g. capstone recordingService appending to a
 * not-yet-created stream) treat absence as "start fresh."
 */
async function downloadBuffer(key) {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
  });
  try {
    const res = await s3.send(command);
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (err) {
    if (err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)) {
      return Buffer.alloc(0);
    }
    throw err;
  }
}

/** Generate a presigned GET URL for a private object. */
async function generateDownloadURL(key, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
  });
  return getSignedUrl(s3, command, { expiresIn });
}

module.exports = {
  s3, generateUploadURL, uploadStream, uploadBuffer, downloadBuffer, generateDownloadURL,
  initiateMultipartUpload, getPartUploadURL, completeMultipartUpload, abortMultipartUpload,
};
