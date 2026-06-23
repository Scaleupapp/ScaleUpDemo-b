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
      return { text: 'Data Structures Chapter 1' };
    },
    extractTopics: makeTopicStub([{ name: 'Data Structures' }]),
  };

  const result = await extractFromBuffer(
    { buffer, mimeType: 'application/pdf', filename: 'syllabus.pdf' },
    deps
  );

  assert.strictEqual(pdfParseCalled, true, 'pdfParse should be called');
  assert.strictEqual(pdfParseInput, buffer, 'pdfParse should receive the buffer');
  assert.strictEqual(result.text, 'Data Structures Chapter 1');
  assert.deepStrictEqual(result.topics, [{ name: 'Data Structures' }]);
});

test('extractFromBuffer: PDF with empty pdf.text returns empty string', async () => {
  const deps = {
    pdfParse: async () => ({ text: undefined }),
    extractTopics: makeTopicStub([]),
  };
  const result = await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: 'application/pdf', filename: 'empty.pdf' },
    deps
  );
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
  const deps = {
    pdfParse: async () => ({ text: 'Machine Learning Overview' }),
    extractTopics: async (text) => {
      topicInput = text;
      return [{ name: 'Neural Networks' }, { name: 'Regression' }];
    },
  };

  const result = await extractFromBuffer(
    { buffer: Buffer.from('x'), mimeType: 'application/pdf', filename: 'ml.pdf' },
    deps
  );

  assert.strictEqual(topicInput, 'Machine Learning Overview', 'extractTopics receives the text');
  assert.deepStrictEqual(result.topics, [{ name: 'Neural Networks' }, { name: 'Regression' }]);
});

test('extractFromBuffer: extractTopics with empty result returns empty array', async () => {
  const deps = {
    pdfParse: async () => ({ text: 'some content' }),
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
