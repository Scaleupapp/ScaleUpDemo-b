'use strict';

const { test } = require('node:test');
const assert = require('assert');

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function buildStubs({ role = 'admin', authError = null } = {}) {
  const authPath = require.resolve('./auth');
  const rbacPath = require.resolve('./rbac');
  const adminPath = require.resolve('./adminAuth');

  // stub auth
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: authError
      ? (req, res, next) => next(authError)
      : (req, res, next) => { req.user = { userId: 'u1', role }; next(); },
  };

  // real rbac (thin function — use actual implementation)
  delete require.cache[rbacPath];
  delete require.cache[adminPath];

  const adminAuth = require('./adminAuth');
  return adminAuth;
}

function teardown() {
  ['./auth', './rbac', './adminAuth'].forEach(p => {
    delete require.cache[require.resolve(p)];
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('adminAuth passes when user has admin role', async () => {
  const adminAuth = buildStubs({ role: 'admin' });
  try {
    const req = {};
    const res = {};
    let nextArg;

    // Run each middleware in sequence
    await new Promise((resolve, reject) => {
      let i = 0;
      const runNext = (err) => {
        if (err) { nextArg = err; resolve(); return; }
        if (i < adminAuth.length) {
          adminAuth[i++](req, res, runNext);
        } else {
          resolve();
        }
      };
      runNext();
    });

    assert.ok(!nextArg, `Expected no error but got: ${nextArg && nextArg.message}`);
    assert.strictEqual(req.user.role, 'admin');
  } finally {
    teardown();
  }
});

test('adminAuth rejects when user has non-admin role', async () => {
  const adminAuth = buildStubs({ role: 'user' });
  try {
    const req = {};
    const res = {};
    let nextArg;

    await new Promise((resolve) => {
      let i = 0;
      const runNext = (err) => {
        if (err) { nextArg = err; resolve(); return; }
        if (i < adminAuth.length) {
          try {
            adminAuth[i++](req, res, runNext);
          } catch (thrownErr) {
            nextArg = thrownErr;
            resolve();
          }
        } else {
          resolve();
        }
      };
      runNext();
    });

    assert.ok(nextArg, 'Expected an error for non-admin role');
    assert.strictEqual(nextArg.statusCode, 403);
  } finally {
    teardown();
  }
});
