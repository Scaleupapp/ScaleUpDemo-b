'use strict';

/**
 * Local sandbox helper — Phase A only.
 *
 * Writes files to a temporary directory, runs a shell command inside it, and
 * cleans up regardless of outcome. Phase B will replace this with a managed
 * cloud sandbox.
 *
 * @param {object} opts
 * @param {{ path: string, content: string }[]} opts.files      — files to materialise
 * @param {string}  opts.command     — shell command to run (via `sh -c`)
 * @param {number} [opts.timeout_ms] — kill timeout in ms (default 15 000)
 * @returns {Promise<{ exit_code: number, stdout: string, stderr: string, timed_out: boolean }>}
 */

const { execFile } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');

async function runInTempDir({ files, command, timeout_ms = 15000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaleup-sbx-'));
  try {
    for (const f of files) {
      const target = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
    }

    return await new Promise((resolve) => {
      execFile(
        'sh',
        ['-c', command],
        {
          cwd: dir,
          timeout: timeout_ms,
          // The API server runs with NODE_ENV=production, which makes
          // `npm install` skip devDependencies (jest, supertest, …) — so test
          // commands then fail with "missing package: jest". Force a full dev
          // install inside the sandbox. maxBuffer is bumped because non-silent
          // npm/jest output can exceed execFile's 1 MB default.
          env: {
            ...process.env,
            NODE_ENV: 'development',
            npm_config_production: 'false',
            npm_config_include: 'dev',
            npm_config_fund: 'false',
            npm_config_audit: 'false',
            CI: 'true',
          },
          maxBuffer: 10 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          resolve({
            exit_code: err ? (err.code || 1) : 0,
            stdout:    stdout || '',
            stderr:    stderr || '',
            timed_out: !!(err && err.signal === 'SIGTERM'),
          });
        }
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runInTempDir };
