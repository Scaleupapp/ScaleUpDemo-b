'use strict';
/**
 * Tests for src/services/institution/assessment/sourceExtractionService.js
 * All deps injected — NO real PDF parsing, NO AI calls, NO S3.
 */
const test = require('node:test');
const assert = require('node:assert');
const { extractFromBuffer, runExtraction } = require('../../services/institution/assessment/sourceExtractionService');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTopicStub(topics = [{ name: 'Topic A' }, { name: 'Topic B' }]) {
  return async (_text) => topics;
}

// ── extractFromBuffer: PDF path ──────────────────────────────────────────────

test('extractFromBuffer: PDF mimeType calls pdfParse and returns text + topics', async () => {
  const buffer = Buffer.from('fake pdf bytes');
  let pdfParseCalled = false;
  let pdfParseInput = null;

  const deps = {
    pdfParse: async (buf) => {
      pdfParseCalled = true;
      pdfParseInput = buf;
      // Return text long enough (>50 chars) to avoid scanned-PDF fallback
      return { text: 'Data Structures Chapter 1: Introduction to Arrays and Linked Lists' };
    },
    // fileExtract stub ensures no real OpenAI call if fallback were triggered
    fileExtract: async () => { throw new Error('fileExtract should not be called for normal PDF'); },
    extractTopics: makeTopicStub([{ name: 'Data Structures' }]),
  };

  const result = await extractFromBuffer(
    { buffer, mimeType: 'application/pdf', filename: 'syllabus.pdf' },
    deps
  );

  assert.strictEqual(pdfParseCalled, true, 'pdfParse should be called');
  assert.strictEqual(pdfParseInput, buffer, 'pdfParse should receive the buffer');
  assert.strictEqual(result.text, 'Data Structures Chapter 1: Introduction to Arrays and Linked Lists');
  assert.deepStrictEqual(result.topics, [{ name: 'Data Structures' }]);
});

test('extractFromBuffer: PDF with empty pdf.text falls back to fileExtract (scanned PDF)', async () => {
  // When pdfParse returns undefined/empty text, the scanned-PDF path calls fileExtract
  let fileExtractCalled = false;
  const deps = {
    pdfParse: async () => ({ text: undefined }),
    fileExtract: async () => { fileExtractCalled = true; return ''; },
    extractTopics: makeTopicStub([]),
  };
  const result = await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: 'application/pdf', filename: 'empty.pdf' },
    deps
  );
  assert.strictEqual(fileExtractCalled, true, 'fileExtract called on near-empty pdf-parse result');
  assert.strictEqual(result.text, '');
  assert.deepStrictEqual(result.topics, []);
});

// ── extractFromBuffer: image path ────────────────────────────────────────────

test('extractFromBuffer: image/* mimeType calls visionOcr (not pdfParse)', async () => {
  const buffer = Buffer.from('fake png bytes');
  let visionCalled = false;
  let pdfCalled = false;

  const deps = {
    pdfParse: async () => { pdfCalled = true; return { text: '' }; },
    visionOcr: async (buf, mime, filename) => {
      visionCalled = true;
      assert.strictEqual(buf, buffer);
      assert.strictEqual(mime, 'image/png');
      return 'Extracted OCR text from image';
    },
    extractTopics: makeTopicStub([{ name: 'Operating Systems' }]),
  };

  const result = await extractFromBuffer(
    { buffer, mimeType: 'image/png', filename: 'notes.png' },
    deps
  );

  assert.strictEqual(visionCalled, true, 'visionOcr must be called for image');
  assert.strictEqual(pdfCalled, false, 'pdfParse must NOT be called for image');
  assert.strictEqual(result.text, 'Extracted OCR text from image');
  assert.deepStrictEqual(result.topics, [{ name: 'Operating Systems' }]);
});

test('extractFromBuffer: image/jpeg also routes to visionOcr', async () => {
  let visionCalled = false;
  const deps = {
    visionOcr: async () => { visionCalled = true; return 'ocr text'; },
    extractTopics: makeTopicStub(),
  };
  await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: 'image/jpeg', filename: 'photo.jpg' },
    deps
  );
  assert.strictEqual(visionCalled, true);
});

// ── extractFromBuffer: text/plain path ──────────────────────────────────────

test('extractFromBuffer: text/plain returns buffer as utf8 string', async () => {
  const content = 'Unit 1: Introduction\nUnit 2: Arrays';
  const buffer = Buffer.from(content, 'utf8');
  let pdfCalled = false, visionCalled = false;

  const deps = {
    pdfParse: async () => { pdfCalled = true; return { text: '' }; },
    visionOcr: async () => { visionCalled = true; return ''; },
    extractTopics: makeTopicStub([{ name: 'Introduction' }, { name: 'Arrays' }]),
  };

  const result = await extractFromBuffer(
    { buffer, mimeType: 'text/plain', filename: 'outline.txt' },
    deps
  );

  assert.strictEqual(result.text, content, 'text/plain should return raw buffer as string');
  assert.strictEqual(pdfCalled, false);
  assert.strictEqual(visionCalled, false);
});

test('extractFromBuffer: unknown mimeType falls back to buffer.toString("utf8")', async () => {
  const content = 'some content';
  const buffer = Buffer.from(content);
  const deps = {
    extractTopics: makeTopicStub(),
  };
  const result = await extractFromBuffer(
    { buffer, mimeType: 'application/octet-stream', filename: 'file.bin' },
    deps
  );
  assert.strictEqual(result.text, content);
});

// ── extractFromBuffer: topic derivation ─────────────────────────────────────

test('extractFromBuffer: extractTopics is called with the extracted text', async () => {
  let topicInput = null;
  // Use text > 50 chars so the scanned-PDF fallback is NOT triggered
  const pdfText = 'Machine Learning Overview: Supervised, Unsupervised and Reinforcement approaches';
  const deps = {
    pdfParse: async () => ({ text: pdfText }),
    fileExtract: async () => { throw new Error('fileExtract should not be called'); },
    extractTopics: async (text) => {
      topicInput = text;
      return [{ name: 'Neural Networks' }, { name: 'Regression' }];
    },
  };

  const result = await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: 'application/pdf', filename: 'ml.pdf' },
    deps
  );

  assert.strictEqual(topicInput, pdfText, 'extractTopics receives the text');
  assert.deepStrictEqual(result.topics, [{ name: 'Neural Networks' }, { name: 'Regression' }]);
});

test('extractFromBuffer: extractTopics with empty result returns empty array', async () => {
  // Use text > 50 chars so the scanned-PDF fallback is NOT triggered
  const pdfText = 'some content with enough characters to pass the scanned threshold check here';
  const deps = {
    pdfParse: async () => ({ text: pdfText }),
    fileExtract: async () => { throw new Error('fileExtract should not be called'); },
    extractTopics: async () => [],
  };
  const result = await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: 'application/pdf', filename: 'f.pdf' },
    deps
  );
  assert.deepStrictEqual(result.topics, []);
});

// ── runExtraction ─────────────────────────────────────────────────────────────

function makeSource(overrides = {}) {
  const source = {
    _id: 'src1',
    s3Key: 'assessment-sources/inst1/src1',
    mimeType: 'application/pdf',
    filename: 'syllabus.pdf',
    status: 'uploaded',
    extractedText: undefined,
    extractedTopics: [],
    error: undefined,
    save: async function () { return this; },
    ...overrides,
  };
  return source;
}

test('runExtraction: happy path — sets status extracting → ready, saves text and topics', async () => {
  const source = makeSource();
  const statusHistory = [];
  source.save = async function () { statusHistory.push(this.status); return this; };

  const deps = {
    AssessmentSource: { findById: async () => source },
    downloadBuffer: async (key) => {
      assert.strictEqual(key, 'assessment-sources/inst1/src1');
      return Buffer.from('pdf bytes');
    },
    extractFromBuffer: async ({ buffer, mimeType }) => {
      return { text: 'Extracted content', topics: [{ name: 'Graph Theory' }] };
    },
  };

  const result = await runExtraction('src1', deps);

  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.extractedText, 'Extracted content');
  assert.deepStrictEqual(result.extractedTopics, [{ name: 'Graph Theory' }]);
  // save called twice: once for 'extracting', once for 'ready'
  assert.deepStrictEqual(statusHistory, ['extracting', 'ready']);
});

test('runExtraction: throws SOURCE_NOT_FOUND when source is missing', async () => {
  const deps = {
    AssessmentSource: { findById: async () => null },
    downloadBuffer: async () => Buffer.alloc(0),
    extractFromBuffer: async () => ({ text: '', topics: [] }),
  };

  await assert.rejects(
    () => runExtraction('missing', deps),
    (err) => {
      assert.strictEqual(err.message, 'SOURCE_NOT_FOUND');
      return true;
    }
  );
});

test('runExtraction: on extractFromBuffer failure sets status "failed" and saves error', async () => {
  const source = makeSource();
  const statuses = [];
  source.save = async function () { statuses.push(this.status); return this; };

  const deps = {
    AssessmentSource: { findById: async () => source },
    downloadBuffer: async () => Buffer.from('x'),
    extractFromBuffer: async () => { throw new Error('OCR_FAILED'); },
  };

  await assert.rejects(
    () => runExtraction('src1', deps),
    (err) => {
      assert.strictEqual(err.message, 'OCR_FAILED');
      return true;
    }
  );

  assert.ok(statuses.includes('extracting'), 'should have set extracting first');
  assert.ok(statuses.includes('failed'), 'should have set failed on error');
  assert.strictEqual(source.error, 'OCR_FAILED');
});

test('runExtraction: on downloadBuffer failure sets status "failed"', async () => {
  const source = makeSource();

  const deps = {
    AssessmentSource: { findById: async () => source },
    downloadBuffer: async () => { throw new Error('S3_ERROR'); },
    extractFromBuffer: async () => ({ text: '', topics: [] }),
  };

  await assert.rejects(
    () => runExtraction('src1', deps),
    (err) => {
      assert.strictEqual(err.message, 'S3_ERROR');
      return true;
    }
  );

  assert.strictEqual(source.status, 'failed');
  assert.strictEqual(source.error, 'S3_ERROR');
});

// ── extractFromBuffer: docx/pptx → fileExtract path ─────────────────────────

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

test('extractFromBuffer: docx mimeType calls fileExtract (not pdfParse, not visionOcr)', async () => {
  const buffer = Buffer.from('fake docx bytes');
  let fileExtractCalled = false;
  let pdfCalled = false;
  let visionCalled = false;

  const deps = {
    pdfParse: async () => { pdfCalled = true; return { text: '' }; },
    visionOcr: async () => { visionCalled = true; return ''; },
    fileExtract: async (buf, filename) => {
      fileExtractCalled = true;
      assert.strictEqual(buf, buffer, 'fileExtract should receive the buffer');
      assert.strictEqual(filename, 'lecture.docx', 'fileExtract should receive filename');
      return 'Extracted DOCX content';
    },
    extractTopics: makeTopicStub([{ name: 'DOCX Topic' }]),
  };

  const result = await extractFromBuffer(
    { buffer, mimeType: DOCX_MIME, filename: 'lecture.docx' },
    deps
  );

  assert.strictEqual(fileExtractCalled, true, 'fileExtract must be called for docx');
  assert.strictEqual(pdfCalled, false, 'pdfParse must NOT be called for docx');
  assert.strictEqual(visionCalled, false, 'visionOcr must NOT be called for docx');
  assert.strictEqual(result.text, 'Extracted DOCX content');
  assert.deepStrictEqual(result.topics, [{ name: 'DOCX Topic' }]);
});

test('extractFromBuffer: pptx mimeType calls fileExtract and returns text + topics', async () => {
  const buffer = Buffer.from('fake pptx bytes');
  let fileExtractCalled = false;

  const deps = {
    fileExtract: async (buf, filename) => {
      fileExtractCalled = true;
      assert.strictEqual(filename, 'slides.pptx');
      return 'Extracted PPTX slide content';
    },
    extractTopics: makeTopicStub([{ name: 'Slide Topic A' }, { name: 'Slide Topic B' }]),
  };

  const result = await extractFromBuffer(
    { buffer, mimeType: PPTX_MIME, filename: 'slides.pptx' },
    deps
  );

  assert.strictEqual(fileExtractCalled, true, 'fileExtract must be called for pptx');
  assert.strictEqual(result.text, 'Extracted PPTX slide content');
  assert.deepStrictEqual(result.topics, [{ name: 'Slide Topic A' }, { name: 'Slide Topic B' }]);
});

test('extractFromBuffer: docx fileExtract result passed to extractTopics', async () => {
  let topicInput = null;
  const deps = {
    fileExtract: async () => 'Word document full text',
    extractTopics: async (text) => {
      topicInput = text;
      return [{ name: 'Extracted Topic' }];
    },
  };

  await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: DOCX_MIME, filename: 'doc.docx' },
    deps
  );

  assert.strictEqual(topicInput, 'Word document full text', 'extractTopics receives fileExtract output');
});

// ── extractFromBuffer: scanned PDF fallback to fileExtract ───────────────────

test('extractFromBuffer: PDF with near-empty text (scanned) falls back to fileExtract', async () => {
  const buffer = Buffer.from('fake scanned pdf bytes');
  let fileExtractCalled = false;
  let pdfParseCalled = false;

  const deps = {
    pdfParse: async (buf) => {
      pdfParseCalled = true;
      // Scanned PDF — pdf-parse returns minimal/whitespace-only text
      return { text: '   \n  ' };
    },
    fileExtract: async (buf, filename) => {
      fileExtractCalled = true;
      return 'Text extracted via OpenAI Files API from scanned PDF';
    },
    extractTopics: makeTopicStub([{ name: 'Scanned Topic' }]),
  };

  const result = await extractFromBuffer(
    { buffer, mimeType: 'application/pdf', filename: 'scanned.pdf' },
    deps
  );

  assert.strictEqual(pdfParseCalled, true, 'pdfParse is always tried first');
  assert.strictEqual(fileExtractCalled, true, 'fileExtract called when pdfParse returns near-empty text');
  assert.strictEqual(result.text, 'Text extracted via OpenAI Files API from scanned PDF');
  assert.deepStrictEqual(result.topics, [{ name: 'Scanned Topic' }]);
});

test('extractFromBuffer: PDF with sufficient text does NOT fall back to fileExtract', async () => {
  let fileExtractCalled = false;

  const deps = {
    pdfParse: async () => ({ text: 'This PDF has enough text to not need fallback. '.repeat(5) }),
    fileExtract: async () => {
      fileExtractCalled = true;
      return 'should not be called';
    },
    extractTopics: makeTopicStub(),
  };

  const result = await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: 'application/pdf', filename: 'normal.pdf' },
    deps
  );

  assert.strictEqual(fileExtractCalled, false, 'fileExtract must NOT be called when pdf-parse returns good text');
  assert.ok(result.text.length > 50, 'result text should be the pdf-parse output');
});

test('extractFromBuffer: PDF with exactly 50 chars (boundary) triggers fileExtract fallback', async () => {
  // Threshold is <= 50 chars trimmed, so exactly 50 triggers the fallback
  const fiftyChars = 'A'.repeat(50);
  let fileExtractCalled = false;

  const deps = {
    pdfParse: async () => ({ text: fiftyChars }),
    fileExtract: async () => { fileExtractCalled = true; return 'fallback text'; },
    extractTopics: makeTopicStub(),
  };

  await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: 'application/pdf', filename: 'boundary.pdf' },
    deps
  );

  assert.strictEqual(fileExtractCalled, true, 'exactly 50 chars DOES trigger fallback (threshold is <= 50)');
});

test('extractFromBuffer: PDF with 51 chars does NOT trigger fileExtract fallback', async () => {
  const fiftyOneChars = 'C'.repeat(51);
  let fileExtractCalled = false;

  const deps = {
    pdfParse: async () => ({ text: fiftyOneChars }),
    fileExtract: async () => { fileExtractCalled = true; return 'should not be called'; },
    extractTopics: makeTopicStub(),
  };

  await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: 'application/pdf', filename: 'normal.pdf' },
    deps
  );

  assert.strictEqual(fileExtractCalled, false, 'PDF with 51 chars should NOT trigger fileExtract fallback');
});

test('extractFromBuffer: PDF with 49 chars trimmed triggers fileExtract fallback', async () => {
  const fortyNineChars = 'B'.repeat(49);
  let fileExtractCalled = false;

  const deps = {
    pdfParse: async () => ({ text: fortyNineChars }),
    fileExtract: async () => { fileExtractCalled = true; return 'fallback text'; },
    extractTopics: makeTopicStub(),
  };

  await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: 'application/pdf', filename: 'short.pdf' },
    deps
  );

  assert.strictEqual(fileExtractCalled, true, 'PDF with < 50 chars triggers fileExtract fallback');
});

// ── allow-list: isAllowedMimeType includes docx and pptx ────────────────────

const { isAllowedMimeType } = require('../../routes/institution/assessmentSources');

test('allow-list: isAllowedMimeType accepts docx mime type', () => {
  assert.strictEqual(
    isAllowedMimeType(DOCX_MIME),
    true,
    'docx should be in the allow-list'
  );
});

test('allow-list: isAllowedMimeType accepts pptx mime type', () => {
  assert.strictEqual(
    isAllowedMimeType(PPTX_MIME),
    true,
    'pptx should be in the allow-list'
  );
});

test('allow-list: isAllowedMimeType still accepts pdf, png, jpeg, webp, text/plain', () => {
  const allowed = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain',
  ];
  for (const mime of allowed) {
    assert.strictEqual(isAllowedMimeType(mime), true, `${mime} should be allowed`);
  }
});

test('allow-list: isAllowedMimeType rejects unknown types', () => {
  const rejected = [
    'application/x-executable',
    'video/mp4',
    'application/zip',
  ];
  for (const mime of rejected) {
    assert.strictEqual(isAllowedMimeType(mime), false, `${mime} should be rejected`);
  }
});
