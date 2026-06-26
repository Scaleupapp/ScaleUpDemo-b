'use strict';
const test = require('node:test'); const assert = require('node:assert');
const Shelf = require('../../models/Shelf');
const ShelfItem = require('../../models/ShelfItem');
const oid = '507f1f77bcf86cd799439011';

test('Shelf requires institutionId, cohortId, title; order defaults 0', () => {
  const err = new Shelf({}).validateSync();
  assert.ok(err.errors.institutionId && err.errors.cohortId && err.errors.title);
  const s = new Shelf({ institutionId: oid, cohortId: oid, title: 'DSA' });
  assert.strictEqual(s.order, 0);
});
test('ShelfItem requires shelfId, type, title and validates the type enum', () => {
  const err = new ShelfItem({}).validateSync();
  assert.ok(err.errors.shelfId && err.errors.type && err.errors.title);
  const bad = new ShelfItem({ shelfId: oid, type: 'video', title: 'x' }).validateSync();
  assert.ok(bad.errors.type);
  const link = new ShelfItem({ shelfId: oid, type: 'link', title: 'GFG', url: 'https://x', note: 'read this' });
  assert.strictEqual(link.url, 'https://x');
});
