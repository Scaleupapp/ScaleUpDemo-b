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
        { cwd: dir, timeout: timeout_ms },
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
