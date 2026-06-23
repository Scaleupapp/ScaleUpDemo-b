'use strict';
/**
 * Tests for src/routes/institution/assessmentSources.js
 * Uses router._deps seam — no real DB, no real S3, no AI calls.
 *
 * Pattern: build a fake express-style req/res and call handlers directly.
 */
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// ── Minimal express-mock helpers ─────────────────────────────────────────────

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

function makeReq({ institutionId = 'inst1', role = 'tpo_head', institutionUserId = 'user1', body = {}, query = {}, params = {}, file = null } = {}) {
  return {
    institution: { institutionId, role, institutionUserId },
    body,
    query,
    params,
    file,
    headers: { authorization: 'Bearer fake' },
  };
}

// ── Load route and get handler references ─────────────────────────────────────
// We bypass multer and institutionAuth/requireInstitutionRole in tests —
// we call individual handlers directly via router.stack.

const router = require('../../routes/institution/assessmentSources');

/**
 * Extract a specific route's async handler by method and path.
 * Walks router.stack to find layers matching method+route.
 */
function getHandler(method, path) {
  const m = method.toLowerCase();
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[m]) {
      const handlers = layer.route.stack;
      // Find the last handler that is the actual async business logic
      const fn = handlers[handlers.length - 1];
      return fn ? fn.handle : undefined;
    }
  }
  throw new Error(`No handler found for ${method} ${path}`);
}

// ── POST /assessment-sources — role gate ─────────────────────────────────────

test('POST /assessment-sources: role gate rejects faculty with 403', async () => {
  // Test the requireInstitutionRole middleware directly
  const { requireInstitutionRole } = require('../../middleware/institutionScope');
  const gate = requireInstitutionRole('tpo_head', 'tpo_coordinator');

  const req = makeReq({ role: 'faculty' });
  const res = makeRes();
  let nextCalled = false;
  gate(req, res, () => { nextCalled = true; });

  assert.strictEqual(res._status, 403, 'faculty should be rejected');
  assert.strictEqual(nextCalled, false);
});

test('POST /assessment-sources: role gate allows tpo_head', () => {
  const { requireInstitutionRole } = require('../../middleware/institutionScope');
  const gate = requireInstitutionRole('tpo_head', 'tpo_coordinator');

  const req = makeReq({ role: 'tpo_head' });
  const res = makeRes();
  let nextCalled = false;
  gate(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true, 'tpo_head should pass');
  assert.strictEqual(res._status, 200, 'no response emitted');
});

test('POST /assessment-sources: role gate allows tpo_coordinator', () => {
  const { requireInstitutionRole } = require('../../middleware/institutionScope');
  const gate = requireInstitutionRole('tpo_head', 'tpo_coordinator');

  const req = makeReq({ role: 'tpo_coordinator' });
  const res = makeRes();
  let nextCalled = false;
  gate(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true, 'tpo_coordinator should pass');
});

// ── POST /assessment-sources — handler logic ─────────────────────────────────

test('POST /assessment-sources: returns 400 when no file', async () => {
  const handler = getHandler('post', '/assessment-sources');

  const req = makeReq({ file: null });
  const res = makeRes();

  router._deps = {
    AssessmentSource: { create: async () => { throw new Error('should not be called'); } },
    uploadBuffer: async () => { throw new Error('should not be called'); },
    runExtraction: async () => {},
  };

  await handler(req, res);

  assert.strictEqual(res._status, 400);
  assert.strictEqual(res._body.code, 'NO_FILE');
});

test('POST /assessment-sources: happy path returns 201 with sourceId and status', async () => {
  const handler = getHandler('post', '/assessment-sources');

  const fakeId = new mongoose.Types.ObjectId();
  let uploadedKey = null;
  let uploadedBuffer = null;
  let createdDoc = null;
  let runExtractionId = null;

  router._deps = {
    AssessmentSource: {
      create: async (doc) => {
        createdDoc = doc;
        return { _id: doc._id, status: 'uploaded' };
      },
    },
    uploadBuffer: async (key, buffer, mime) => {
      uploadedKey = key;
      uploadedBuffer = buffer;
    },
    runExtraction: async (id) => {
      runExtractionId = String(id);
    },
  };

  const file = {
    originalname: 'syllabus.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('fake pdf'),
  };

  const req = makeReq({
    institutionId: 'inst1',
    institutionUserId: 'user1',
    body: { cohortId: 'cohort1' },
    file,
  });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 201);
  assert.strictEqual(res._body.success, true);
  assert.ok(res._body.data.sourceId, 'should return sourceId');
  assert.strictEqual(res._body.data.status, 'uploaded');

  // S3 upload was called
  assert.ok(uploadedKey.startsWith('assessment-sources/inst1/'), 'S3 key should be scoped');
  assert.strictEqual(uploadedBuffer, file.buffer);

  // DB record created with correct fields
  assert.strictEqual(String(createdDoc.institutionId), 'inst1');
  assert.strictEqual(createdDoc.filename, 'syllabus.pdf');
  assert.strictEqual(createdDoc.mimeType, 'application/pdf');
  assert.strictEqual(createdDoc.s3Key, uploadedKey);

  // runExtraction was called (we cannot verify it's fire-and-forget but at least called)
  assert.ok(runExtractionId, 'runExtraction should have been called');
});

test('POST /assessment-sources: cohortId is optional', async () => {
  const handler = getHandler('post', '/assessment-sources');
  let createdDoc = null;

  router._deps = {
    AssessmentSource: {
      create: async (doc) => { createdDoc = doc; return { _id: doc._id, status: 'uploaded' }; },
    },
    uploadBuffer: async () => {},
    runExtraction: async () => {},
  };

  const req = makeReq({ file: { originalname: 'notes.pdf', mimetype: 'application/pdf', buffer: Buffer.from('x') } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res._status, 201);
  assert.strictEqual(createdDoc.cohortId, undefined, 'cohortId should be undefined when not provided');
});

// ── GET /assessment-sources — list ───────────────────────────────────────────

test('GET /assessment-sources: returns list scoped to institutionId', async () => {
  const handler = getHandler('get', '/assessment-sources');

  const fakeList = [
    { _id: 'src1', filename: 'a.pdf', status: 'ready', extractedTopics: [{ name: 'T1' }, { name: 'T2' }], createdAt: new Date() },
    { _id: 'src2', filename: 'b.png', status: 'uploaded', extractedTopics: [], createdAt: new Date() },
  ];

  let filterUsed = null;

  router._deps = {
    AssessmentSource: {
      find: (filter) => {
        filterUsed = filter;
        const chain = {
          select: () => chain,
          sort: () => chain,
          lean: () => Promise.resolve(fakeList),
        };
        return chain;
      },
    },
    uploadBuffer: async () => {},
    runExtraction: async () => {},
  };

  const req = makeReq({ institutionId: 'inst1', query: {} });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.success, true);
  assert.strictEqual(res._body.data.length, 2);
  assert.strictEqual(res._body.data[0].topicsCount, 2);
  assert.strictEqual(res._body.data[1].topicsCount, 0);
  assert.strictEqual(filterUsed.institutionId, 'inst1', 'should scope by institutionId');
  assert.strictEqual(filterUsed.cohortId, undefined, 'cohortId filter absent when not in query');
});

test('GET /assessment-sources: filters by cohortId when provided in query', async () => {
  const handler = getHandler('get', '/assessment-sources');
  let filterUsed = null;

  router._deps = {
    AssessmentSource: {
      find: (filter) => {
        filterUsed = filter;
        const chain = {
          select: () => chain,
          sort: () => chain,
          lean: () => Promise.resolve([]),
        };
        return chain;
      },
    },
    uploadBuffer: async () => {},
    runExtraction: async () => {},
  };

  const req = makeReq({ institutionId: 'inst1', query: { cohortId: 'c99' } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(filterUsed.cohortId, 'c99');
});

// ── GET /assessment-sources/:id — detail ─────────────────────────────────────

test('GET /assessment-sources/:id: returns source detail when found', async () => {
  const handler = getHandler('get', '/assessment-sources/:id');
  const fakeSource = {
    _id: 'src1',
    status: 'ready',
    filename: 'outline.pdf',
    extractedTopics: [{ name: 'Graphs' }, { name: 'Trees' }],
    error: null,
  };

  router._deps = {
    AssessmentSource: {
      findOne: (filter) => {
        assert.strictEqual(String(filter._id), 'src1');
        assert.strictEqual(String(filter.institutionId), 'inst1');
        return { lean: async () => fakeSource };
      },
    },
    uploadBuffer: async () => {},
    runExtraction: async () => {},
  };

  const req = makeReq({ institutionId: 'inst1', params: { id: 'src1' } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.success, true);
  assert.strictEqual(res._body.data.id, 'src1');
  assert.strictEqual(res._body.data.status, 'ready');
  assert.strictEqual(res._body.data.filename, 'outline.pdf');
  assert.strictEqual(res._body.data.extractedTopics.length, 2);
});

test('GET /assessment-sources/:id: returns 404 when not found', async () => {
  const handler = getHandler('get', '/assessment-sources/:id');

  router._deps = {
    AssessmentSource: {
      findOne: () => ({ lean: async () => null }),
    },
    uploadBuffer: async () => {},
    runExtraction: async () => {},
  };

  const req = makeReq({ params: { id: 'missing' } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.success, false);
});

test('GET /assessment-sources/:id: does not return source from another institution', async () => {
  const handler = getHandler('get', '/assessment-sources/:id');
  let filterUsed = null;

  router._deps = {
    AssessmentSource: {
      findOne: (filter) => {
        filterUsed = filter;
        return { lean: async () => null }; // simulates isolation
      },
    },
    uploadBuffer: async () => {},
    runExtraction: async () => {},
  };

  const req = makeReq({ institutionId: 'inst-A', params: { id: 'srcX' } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(String(filterUsed.institutionId), 'inst-A', 'must scope by caller institutionId');
  assert.strictEqual(res._status, 404);
});
