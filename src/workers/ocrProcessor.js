const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');
const Content = require('../models/Content');
const { s3 } = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const openai = require('../config/openai');

/**
 * OCR Processing Worker
 *
 * Extracts text from notes (PDF/images).
 * - Text PDFs: Uses pdf-parse (fast, free)
 * - Scanned/handwritten PDFs: Falls back to GPT-4o Vision
 * Then re-queues for AI analysis (same pipeline as video content).
 *
 * Cost: Text PDFs = free. Vision OCR ≈ $0.01-0.03/page.
 */
async function processOCR(job) {
  const { contentId } = job.data;
  const content = await Content.findById(contentId);
  if (!content) return { status: 'skipped', reason: 'content_not_found' };
  if (content.contentType !== 'notes') return { status: 'skipped', reason: 'not_notes' };
  if (content.ocrText && content.ocrText.length > 100) return { status: 'skipped', reason: 'already_processed' };

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `ocr_${contentId}${path.extname(content.s3Key || '.pdf')}`);

  try {
    content.aiStatus = 'processing';
    await content.save();
    await job.updateProgress(10);

    // Download from S3
    const s3Response = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: content.s3Key,
    }));
    const writeStream = fs.createWriteStream(tmpFile);
    await pipeline(s3Response.Body, writeStream);
    await job.updateProgress(30);

    let extractedText = '';
    let pageCount = 0;

    // Try text extraction with pdf-parse first
    if (content.fileFormat === 'pdf' || content.s3Key?.endsWith('.pdf')) {
      try {
        const pdfParse = require('pdf-parse');
        const dataBuffer = fs.readFileSync(tmpFile);
        const pdfData = await pdfParse(dataBuffer);
        extractedText = pdfData.text || '';
        pageCount = pdfData.numpages || 0;
      } catch (pdfErr) {
        console.log(`[OCR] pdf-parse failed for ${contentId}, will try Vision:`, pdfErr.message);
      }
    }

    await job.updateProgress(50);

    // If text extraction got very little text (likely scanned/handwritten), use GPT-4o Vision
    if (extractedText.trim().length < 100) {
      console.log(`[OCR] Text extraction insufficient (${extractedText.length} chars), using GPT-4o Vision`);

      // Read file as base64 for Vision API
      const fileBuffer = fs.readFileSync(tmpFile);
      const base64 = fileBuffer.toString('base64');
      const mimeType = content.s3Key?.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';

      // For PDFs, we send as a document. For images, send directly.
      // GPT-4o can handle PDFs natively now
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are an OCR assistant. Extract ALL text from the provided document. Preserve the structure, headings, bullet points, and formatting as much as possible. For handwritten text, do your best to accurately transcribe. Return only the extracted text, nothing else.',
          },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' },
              },
              { type: 'text', text: 'Extract all text from this document.' },
            ],
          },
        ],
        max_tokens: 4096,
        temperature: 0.1,
      });

      extractedText = response.choices[0]?.message?.content || '';
      if (!pageCount) pageCount = 1; // At least 1 page if we got here
    }

    await job.updateProgress(70);

    if (extractedText.trim().length < 20) {
      content.aiStatus = 'failed';
      await content.save();
      return { status: 'failed', reason: 'no_text_extracted' };
    }

    // Store OCR results
    content.ocrText = extractedText;
    content.pageCount = pageCount || 1;
    await content.save();

    await job.updateProgress(80);

    // Re-queue for AI analysis (same as video pipeline)
    const { contentProcessingQueue } = require('../config/queue');
    await contentProcessingQueue.add('process', { contentId: content._id.toString() });

    await job.updateProgress(100);
    return { status: 'completed', textLength: extractedText.length, pageCount };

  } catch (err) {
    console.error(`[OCR] Failed for ${contentId}:`, err.message);
    content.aiStatus = 'failed';
    await content.save();
    throw err;
  } finally {
    // Cleanup temp file
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

module.exports = processOCR;
