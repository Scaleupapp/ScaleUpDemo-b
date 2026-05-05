const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const CTRL_PATH = path.resolve(__dirname, './diagnosticSyllabusController.js');

function buildReqRes({ body = {}, params = {}, user = { _id: 'u1' } } = {}) {
  const res = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return [{ body, params, user }, res];
}

function stubAt(absPath, exports_) {
  delete require.cache[absPath];
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports: exports_ };
}

function loadCtrl({ s3, queue, model }) {
  stubAt(require.resolve(path.resolve(__dirname, '..', 'config', 's3.js')), s3 || {
    generateUploadURL: async () => ({ uploadURL: 'https://s3/url', key: 's3/key/abc' }),
  });
  stubAt(require.resolve(path.resolve(__dirname, '..', 'config', 'queue.js')), queue || {
    ocrProcessingQueue: { add: async () => ({ id: 'job-1' }) },
  });
  stubAt(require.resolve(path.resolve(__dirname, '..', 'models', 'DiagnosticSyllabus.js')), model);
  delete require.cache[CTRL_PATH];
  return require(CTRL_PATH);
}

test('initSyllabusUpload: 400 when fileSizeBytes missing', async () => {
  const created = [];
  const FakeModel = class { constructor(d) { Object.assign(this, d); } async save() { this._id = 'syl-1'; created.push(this); return this; } };
  const ctrl = loadCtrl({ model: FakeModel });
  const [req, res] = buildReqRes({ body: { userObjectiveId: 'o1', contentType: 'application/pdf' } });
  await ctrl.initSyllabusUpload(req, res);
  assert.strictEqual(res.statusCode, 400);
});

test('initSyllabusUpload: returns presigned URL + creates DiagnosticSyllabus', async () => {
  const saved = [];
  const FakeModel = class {
    constructor(d) { Object.assign(this, d); }
    async save() { this._id = 'syl-1'; saved.push(this); return this; }
  };
  const s3Calls = [];
  const ctrl = loadCtrl({
    model: FakeModel,
    s3: { generateUploadURL: async (...args) => { s3Calls.push(args); return { uploadURL: 'https://s3/up', key: 's3/key/xyz' }; } },
  });
  const [req, res] = buildReqRes({
    user: { _id: 'u1' },
    body: { userObjectiveId: 'obj-1', contentType: 'application/pdf', fileSizeBytes: 1024 },
  });
  await ctrl.initSyllabusUpload(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.syllabusId, 'syl-1');
  assert.strictEqual(res.body.uploadUrl, 'https://s3/up');
  assert.strictEqual(res.body.s3Key, 's3/key/xyz');
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].extractionStatus, 'pending');
});

test('completeSyllabusUpload: queues extraction and marks processing', async () => {
  const updated = [];
  const FakeModel = {
    findOne: async () => null, // no cache hit
    findOneAndUpdate: async (filter, update) => {
      updated.push({ filter, update });
      return { _id: filter._id, extractionStatus: update.$set.extractionStatus, contentHash: update.$set.contentHash, s3Key: 's3-x', contentType: 'application/pdf' };
    },
  };
  const queueAdds = [];
  const ctrl = loadCtrl({
    model: FakeModel,
    queue: { ocrProcessingQueue: { add: async (name, payload) => { queueAdds.push({ name, payload }); return { id: 'job-1' }; } } },
  });
  const [req, res] = buildReqRes({
    user: { _id: 'u1' },
    params: { id: 'syl-1' },
    body: { contentHash: 'sha256-abc' },
  });
  await ctrl.completeSyllabusUpload(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, 'processing');
  assert.strictEqual(updated[0].update.$set.extractionStatus, 'processing');
  assert.strictEqual(queueAdds.length, 1);
  assert.strictEqual(queueAdds[0].payload.syllabusId, 'syl-1');
});

test('completeSyllabusUpload: 404 when syllabus not found / not owned', async () => {
  const FakeModel = { findOne: async () => null, findOneAndUpdate: async () => null };
  const ctrl = loadCtrl({ model: FakeModel });
  const [req, res] = buildReqRes({ params: { id: 'syl-x' }, body: { contentHash: 'h' } });
  await ctrl.completeSyllabusUpload(req, res);
  assert.strictEqual(res.statusCode, 404);
});

test('getSyllabusStatus: returns status + topics when completed', async () => {
  const FakeModel = {
    findOne: async () => ({
      _id: 'syl-1',
      extractionStatus: 'completed',
      extractedTopics: [{ canonicalName: 'a', displayName: 'A', description: 'd' }],
      failureReason: null,
    }),
  };
  const ctrl = loadCtrl({ model: FakeModel });
  const [req, res] = buildReqRes({ params: { id: 'syl-1' } });
  await ctrl.getSyllabusStatus(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, 'completed');
  assert.strictEqual(res.body.extractedTopics.length, 1);
});

test('getSyllabusStatus: 404 when not found', async () => {
  const FakeModel = { findOne: async () => null };
  const ctrl = loadCtrl({ model: FakeModel });
  const [req, res] = buildReqRes({ params: { id: 'syl-x' } });
  await ctrl.getSyllabusStatus(req, res);
  assert.strictEqual(res.statusCode, 404);
});
