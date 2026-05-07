'use strict';

const { test } = require('node:test');
const assert = require('assert');

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function buildStubs({ queueDepth = 0, admins = [], emailError = false } = {}) {
  const qbPath     = require.resolve('../models/DiagnosticQuestionBank');
  const userPath   = require.resolve('../models/User');
  const emailPath  = require.resolve('../services/emailService');
  const workerPath = require.resolve('./adminDigestWorker');

  const emailsSent = [];

  require.cache[qbPath] = {
    id: qbPath, filename: qbPath, loaded: true,
    exports: {
      countDocuments: async () => queueDepth,
    },
  };

  require.cache[userPath] = {
    id: userPath, filename: userPath, loaded: true,
    exports: {
      find: () => ({
        select: function () { return this; },
        lean:   async () => admins,
      }),
    },
  };

  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: {
      sendAdminQuestionDigest: async (email, payload) => {
        if (emailError) throw new Error('SMTP failure');
        emailsSent.push({ email, ...payload });
      },
    },
  };

  delete require.cache[workerPath];
  const worker = require('./adminDigestWorker');
  return { worker, getEmails: () => emailsSent };
}

function teardown() {
  [
    '../models/DiagnosticQuestionBank',
    '../models/User',
    '../services/emailService',
    './adminDigestWorker',
  ].forEach(p => {
    try { delete require.cache[require.resolve(p)]; } catch {}
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('adminDigestWorker skips email when queue is empty', async () => {
  const { worker, getEmails } = buildStubs({ queueDepth: 0, admins: [{ email: 'admin@test.com', firstName: 'Admin' }] });
  try {
    const result = await worker.run();
    assert.strictEqual(result.emailed, 0);
    assert.strictEqual(result.queueDepth, 0);
    assert.strictEqual(getEmails().length, 0, 'No emails should be sent when queue is empty');
  } finally {
    teardown();
  }
});

test('adminDigestWorker emails all admins with correct queue depth when queue has items', async () => {
  const admins = [
    { email: 'admin1@test.com', firstName: 'Alice' },
    { email: 'admin2@test.com', firstName: 'Bob' },
  ];
  const { worker, getEmails } = buildStubs({ queueDepth: 12, admins });
  try {
    const result = await worker.run();
    assert.strictEqual(result.emailed, 2);
    assert.strictEqual(result.queueDepth, 12);
    const emails = getEmails();
    assert.strictEqual(emails.length, 2);
    assert.ok(emails.every(e => e.queueDepth === 12), 'Each email should report correct queue depth');
    assert.ok(emails.every(e => typeof e.estimatedMinutes === 'number'), 'estimatedMinutes should be a number');
    assert.ok(emails.every(e => e.dashboardUrl), 'dashboardUrl should be present');
  } finally {
    teardown();
  }
});
