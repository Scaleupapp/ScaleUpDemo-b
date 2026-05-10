const test = require('node:test');
const assert = require('node:assert');

delete require.cache[require.resolve('./ExternalContentSnapshot')];
const ExternalContentSnapshot = require('./ExternalContentSnapshot');

test('ExternalContentSnapshot: validates with required url', () => {
  const doc = new ExternalContentSnapshot({
    url: 'https://ocw.mit.edu/x',
    title: 'MIT OCW: X',
    excerpt: 'Lecture notes...',
    contentType: 'article',
    wordCount: 1500,
  });
  assert.strictEqual(doc.validateSync(), undefined);
  assert.strictEqual(doc.url, 'https://ocw.mit.edu/x');
  assert.ok(doc.fetchedAt instanceof Date);
});

test('ExternalContentSnapshot: requires url', () => {
  const doc = new ExternalContentSnapshot({ excerpt: 'no url here' });
  const err = doc.validateSync();
  assert.ok(err && err.errors.url);
});

test('ExternalContentSnapshot: stores fetchError when fetch failed', () => {
  const doc = new ExternalContentSnapshot({
    url: 'https://broken.example.com',
    fetchError: 'ECONNREFUSED',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.fetchError, 'ECONNREFUSED');
});
