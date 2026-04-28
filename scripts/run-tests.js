#!/usr/bin/env node
/**
 * Test runner: executes each *.test.js file in its own subprocess.
 * Each subprocess uses --test-force-exit so it exits cleanly even
 * when production modules open long-lived handles (BullMQ, Redis, etc.).
 * A per-file timeout prevents any single file from hanging forever.
 *
 * Exit code: 0 if all files pass, 1 if any file has failures or errors.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const FILE_TIMEOUT_MS = 30_000; // 30 s per file

// Discover all test files under src/
function findTestFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results.sort();
}

const testFiles = findTestFiles(path.join(ROOT, 'src'));

if (testFiles.length === 0) {
  console.error('No test files found under src/');
  process.exit(1);
}

console.log(`Found ${testFiles.length} test file(s).\n`);

let totalPass = 0;
let totalFail = 0;
let totalFiles = testFiles.length;
let failedFiles = [];

for (const file of testFiles) {
  const rel = path.relative(ROOT, file);
  process.stdout.write(`Running ${rel} ... `);

  const result = spawnSync(
    process.execPath,
    ['--test', '--test-force-exit', '--test-reporter=spec', file],
    {
      cwd: ROOT,
      timeout: FILE_TIMEOUT_MS,
      encoding: 'utf8',
      // Merge stderr into stdout so spec output appears together
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  // spawnSync sets error.code = 'ETIMEDOUT' when timeout fires
  if (result.error && result.error.code === 'ETIMEDOUT') {
    console.log('TIMED OUT');
    failedFiles.push({ file: rel, reason: 'timed out' });
    totalFail += 1;
    continue;
  }

  // Count pass/fail lines in spec output (TAP-like summary lines)
  const output = (result.stdout || '') + (result.stderr || '');
  // Node's spec reporter emits summary lines like:  ℹ pass 13  / ℹ fail 0
  // The ℹ character may also appear as its Unicode escape ℹ
  const passCountMatch = output.match(/(?:ℹ|i)\s+pass\s+(\d+)/);
  const failCountMatch = output.match(/(?:ℹ|i)\s+fail\s+(\d+)/);

  const filePass = passCountMatch ? parseInt(passCountMatch[1], 10) : 0;
  const fileFail = failCountMatch ? parseInt(failCountMatch[1], 10) : 0;
  totalPass += filePass;
  totalFail += fileFail;

  // The subprocess exits non-zero when tests fail
  if (result.status !== 0) {
    console.log(`FAILED (exit ${result.status}, pass=${filePass}, fail=${fileFail})`);
    failedFiles.push({ file: rel, reason: `exit code ${result.status}` });
    // Print full output so the user can see what failed
    process.stdout.write(output);
  } else {
    console.log(`ok (pass=${filePass})`);
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Files : ${totalFiles} run`);
console.log(`Tests : ${totalPass} passed, ${totalFail} failed`);

if (failedFiles.length > 0) {
  console.log('\nFailed files:');
  for (const { file, reason } of failedFiles) {
    console.log(`  - ${file} (${reason})`);
  }
  console.log('\nnpm test FAILED');
  process.exit(1);
} else {
  console.log('\nnpm test PASSED');
  process.exit(0);
}
