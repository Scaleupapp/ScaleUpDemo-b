'use strict';
/**
 * sourceExtractionService.js
 *
 * Extracts text + syllabus topics from an uploaded buffer.
 *
 * Extraction logic:
 *   - application/pdf        → pdf-parse; if near-empty (<= SCANNED_PDF_THRESHOLD chars
 *                              of trimmed text), falls back to fileExtract (OpenAI Files API)
 *   - image/*                → GPT-4o vision OCR (deps.visionOcr injectable)
 *   - application/vnd.openxmlformats-officedocument.wordprocessingml.document (docx)
 *   - application/vnd.openxmlformats-officedocument.presentationml.presentation (pptx)
 *                            → fileExtract (OpenAI Files API — deps.fileExtract injectable)
 *   - anything else          → buffer.toString('utf8')
 *
 * Topic derivation:
 *   - Calls deps.extractTopics (default: asks GPT-4o for 5-15 topic names)
 *   - Input text is truncated to 8000 chars before sending to the LLM.
 *
 * All external I/O (pdfParse, visionOcr, fileExtract, extractTopics, AssessmentSource,
 * downloadBuffer) is injectable so tests run without real I/O.
 */

const MAX_TOPIC_TEXT = 8000;

// MIME types for Office documents that use the OpenAI Files API path
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Scanned PDFs produce nearly-empty text from pdf-parse; fall back at this threshold
const SCANNED_PDF_THRESHOLD = 50;

// ── Default: OpenAI Files API extraction (docx, pptx, scanned PDFs) ─────────

/**
 * Upload a buffer to the OpenAI Files API and ask GPT-4o to extract its text.
 * Pattern mirrors src/workers/ocrProcessor.js lines ~95-116.
 *
 * @param {Buffer} buffer
 * @param {string} filename - used as the file name when uploading
 * @returns {Promise<string>}
 */
async function defaultFileExtract(buffer, filename) {
  const { Readable } = require('stream');
const { OPENAI_CHAT_MODEL } = require('../../../config/openaiModels');
  const openai = require('../../../config/openai');

  // openai.files.create requires a ReadableStream (Node Readable) plus name/type hints
  const stream = Readable.from(buffer);
  stream.path = filename || 'document';

  const uploaded = await openai.files.create({
    file: stream,
    purpose: 'assistants',
  });

  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are an OCR assistant. Extract ALL text from the provided document. Preserve structure, headings, bullet points. For handwritten text, do your best to accurately transcribe. Return only the extracted text.',
        },
        {
          role: 'user',
          content: [
            { type: 'file', file: { file_id: uploaded.id } },
            { type: 'text', text: 'Extract all text from this document.' },
          ],
        },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    });
    return response.choices[0]?.message?.content || '';
  } finally {
    // Clean up the uploaded file; ignore errors (best-effort)
    try { await openai.files.del(uploaded.id); } catch (_) {}
  }
}

// ── Default: GPT-4o vision OCR ──────────────────────────────────────────────

async function defaultVisionOcr(buffer, mimeType) {
  const openai = require('../../../config/openai');
  const base64 = buffer.toString('base64');
  const response = await openai.chat.completions.create({
    model: OPENAI_CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You are an OCR assistant. Extract ALL text from the provided image. Preserve structure, headings, bullet points. For handwritten text, do your best to accurately transcribe. Return only the extracted text.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
              detail: 'high',
            },
          },
          { type: 'text', text: 'Extract all text from this image.' },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0.1,
  });
  return response.choices[0]?.message?.content || '';
}

// ── Default: topic extraction via GPT-4o ────────────────────────────────────

async function defaultExtractTopics(text) {
  const aiProvider = require('../../../config/aiProvider');
  const snippet = text.slice(0, MAX_TOPIC_TEXT);
  const result = await aiProvider.generateWithGPT({
    systemPrompt:
      'You are a curriculum analyst. Given syllabus or course content, identify the key topics. Return a JSON object with a single key "topics" whose value is an array of 5-15 topic name strings. Example: {"topics": ["Data Structures", "Sorting Algorithms"]}.',
    userPrompt: `Extract 5-15 topic names from the following content:\n\n${snippet}`,
    temperature: 0.3,
    maxTokens: 800,
  });
  // result is already parsed JSON (aiProvider.generateWithGPT returns parsed object)
  const names = Array.isArray(result.topics) ? result.topics : [];
  return names.map((n) => ({ name: String(n) }));
}

// ── extractFromBuffer ────────────────────────────────────────────────────────

/**
 * Extract text and topics from a file buffer.
 *
 * @param {{ buffer: Buffer, mimeType: string, filename: string }} file
 * @param {object} deps - injectable { pdfParse, visionOcr, fileExtract, extractTopics }
 * @returns {Promise<{ text: string, topics: Array<{name:string}> }>}
 */
async function extractFromBuffer({ buffer, mimeType, filename }, deps = {}) {
  const pdfParse = deps.pdfParse || null;
  const visionOcr = deps.visionOcr || defaultVisionOcr;
  const fileExtract = deps.fileExtract || defaultFileExtract;
  const extractTopics = deps.extractTopics || defaultExtractTopics;

  let text = '';

  if (mimeType === 'application/pdf') {
    const parseFn = pdfParse || require('pdf-parse');
    const data = await parseFn(buffer);
    text = data.text || '';
    // Scanned PDF: pdf-parse returns near-empty text (image-only pages).
    // Fall back to the OpenAI Files API extraction path so we don't lose content.
    if (text.trim().length <= SCANNED_PDF_THRESHOLD) {
      text = await fileExtract(buffer, filename);
    }
  } else if (mimeType === DOCX_MIME || mimeType === PPTX_MIME) {
    // Office documents: upload to OpenAI Files API and let GPT-4o extract text
    text = await fileExtract(buffer, filename);
  } else if (mimeType.startsWith('image/')) {
    text = await visionOcr(buffer, mimeType, filename);
  } else {
    // text/plain or anything else
    text = buffer.toString('utf8');
  }

  const topics = await extractTopics(text);

  return { text, topics };
}

// ── runExtraction ────────────────────────────────────────────────────────────

/**
 * Load an AssessmentSource by id, run extraction, and persist results.
 *
 * @param {string|ObjectId} sourceId
 * @param {object} deps - injectable { AssessmentSource, downloadBuffer, extractFromBuffer }
 */
async function runExtraction(sourceId, deps = {}) {
  const AssessmentSource =
    deps.AssessmentSource || require('../../../models/AssessmentSource');
  // Resolve require paths relative to this file
  const downloadBufferFn =
    deps.downloadBuffer ||
    require('../../../config/s3').downloadBuffer;
  const extractFromBufferFn = deps.extractFromBuffer || extractFromBuffer;

  const source = await AssessmentSource.findById(sourceId);
  if (!source) throw new Error('SOURCE_NOT_FOUND');

  source.status = 'extracting';
  await source.save();

  try {
    const buffer = await downloadBufferFn(source.s3Key);
    const { text, topics } = await extractFromBufferFn(
      { buffer, mimeType: source.mimeType, filename: source.filename },
      deps
    );
    source.extractedText = text;
    source.extractedTopics = topics;
    source.status = 'ready';
    await source.save();
  } catch (err) {
    source.status = 'failed';
    source.error = err.message;
    try { await source.save(); } catch (_) {}
    throw err;
  }

  return source;
}

module.exports = { extractFromBuffer, runExtraction };
