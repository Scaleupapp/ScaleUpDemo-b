'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const DriveBookmark = require('../../models/DriveBookmark');

test('DriveBookmark requires userId', () => {
  const err = new DriveBookmark({ driveId: new mongoose.Types.ObjectId() }).validateSync();
  assert.ok(err && err.errors.userId, 'userId is required');
});

test('DriveBookmark requires driveId', () => {
  const err = new DriveBookmark({ userId: new mongoose.Types.ObjectId() }).validateSync();
  assert.ok(err && err.errors.driveId, 'driveId is required');
});

test('DriveBookmark createdAt defaults to a Date', () => {
  const doc = new DriveBookmark({
    userId:  new mongoose.Types.ObjectId(),
    driveId: new mongoose.Types.ObjectId(),
  });
  assert.ok(doc.createdAt instanceof Date, 'createdAt should be a Date');
});
