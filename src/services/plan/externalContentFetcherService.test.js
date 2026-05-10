const test = require('node:test');
const assert = require('node:assert');

// Stub axios + ExternalContentSnapshot before requiring the service
const ExternalContentSnapshot = require('../../models/ExternalContentSnapshot');

delete require.cache[require.resolve('./externalContentFetcherService')];
const fetcher = require('./externalContentFetcherService');

function chainLean(value) { return { lean: async () => value }; }

test('fetchSnapshot: returns cached snapshot when not in error state', async () => {
  const cached = { url: 'https://ocw.mit.edu/x', title: 'cached', excerpt: 'cached body', contentType: 'article', wordCount: 100, fetchError: null };
  const origFind = ExternalContentSnapshot.findOne;
  ExternalContentSnapshot.findOne = () => chainLean(cached);
  try {
    const out = await fetcher.fetchSnapshot('https://ocw.mit.edu/x');
    assert.strictEqual(out.title, 'cached');
    assert.strictEqual(out.excerpt, 'cached body');
  } finally {
    ExternalContentSnapshot.findOne = origFind;
  }
});

test('fetchSnapshot: returns fetchError for invalid_url on null/empty', async () => {
  const out1 = await fetcher.fetchSnapshot('');
  assert.strictEqual(out1.fetchError, 'invalid_url');
  const out2 = await fetcher.fetchSnapshot(null);
  assert.strictEqual(out2.fetchError, 'invalid_url');
});

test('fetchSnapshot: pdf URLs return pdf_unsupported error', async () => {
  const origFind = ExternalContentSnapshot.findOne;
  ExternalContentSnapshot.findOne = () => chainLean(null);
  const origUpsert = ExternalContentSnapshot.findOneAndUpdate;
  ExternalContentSnapshot.findOneAndUpdate = async () => ({});
  try {
    const out = await fetcher.fetchSnapshot('https://example.com/paper.pdf');
    assert.strictEqual(out.contentType, 'pdf');
    assert.strictEqual(out.fetchError, 'pdf_unsupported');
  } finally {
    ExternalContentSnapshot.findOne = origFind;
    ExternalContentSnapshot.findOneAndUpdate = origUpsert;
  }
});
