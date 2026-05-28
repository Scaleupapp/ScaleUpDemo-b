'use strict';

const crypto = require('crypto');

/**
 * Diff computation — produces a structured summary of changes between the
 * bundle's starter_repo and the learner's final filetree, plus a unified-
 * diff representation the LLM can read.
 *
 * Why not use the `diff` npm package directly:
 *   - We want both human-readable hunks AND machine-summary counts in one
 *     pass to feed the evaluator prompt + the result.dimension_scores.
 *   - The starter is just a list of files (no real git history) so we
 *     don't need three-way merge / rename detection — straight per-file
 *     line-diff is sufficient.
 *
 * Inputs:
 *   - starter: { files: [{ path, content }] }
 *   - final:   the same shape, post-edits, pulled from the sandbox at submit
 *
 * Output:
 *   {
 *     files_changed:  number,
 *     files_added:    string[],
 *     files_deleted:  string[],
 *     lines_added:    number,
 *     lines_removed:  number,
 *     unified_diff:   string,  // for the LLM
 *     per_file: [
 *       { path, status: 'added'|'modified'|'deleted'|'unchanged',
 *         added: number, removed: number, hash_before, hash_after, hunks?: string }
 *     ]
 *   }
 */

/**
 * @param {{ files: Array<{path: string, content: string}> }} starter
 * @param {{ files: Array<{path: string, content: string}> }} final
 * @returns {{
 *   files_changed: number, files_added: string[], files_deleted: string[],
 *   lines_added: number, lines_removed: number, unified_diff: string,
 *   per_file: Array<object>
 * }}
 */
function diffTrees(starter, final) {
  const before = new Map((starter?.files || []).map((f) => [f.path, f.content]));
  const after = new Map((final?.files || []).map((f) => [f.path, f.content]));

  const allPaths = new Set([...before.keys(), ...after.keys()]);
  const sortedPaths = Array.from(allPaths).sort();

  const summary = {
    files_changed: 0,
    files_added: [],
    files_deleted: [],
    lines_added: 0,
    lines_removed: 0,
    unified_diff: '',
    per_file: [],
  };

  const hunkChunks = [];

  for (const p of sortedPaths) {
    const a = before.get(p);
    const b = after.get(p);
    const hashA = a != null ? hash(a) : null;
    const hashB = b != null ? hash(b) : null;

    if (a == null && b != null) {
      const lines = (b.match(/\n/g) || []).length + (b.length > 0 && !b.endsWith('\n') ? 1 : 0);
      summary.files_added.push(p);
      summary.files_changed += 1;
      summary.lines_added += lines;
      summary.per_file.push({
        path: p,
        status: 'added',
        added: lines,
        removed: 0,
        hash_before: null,
        hash_after: hashB,
      });
      hunkChunks.push(renderUnified(p, '', b));
    } else if (a != null && b == null) {
      const lines = (a.match(/\n/g) || []).length + (a.length > 0 && !a.endsWith('\n') ? 1 : 0);
      summary.files_deleted.push(p);
      summary.files_changed += 1;
      summary.lines_removed += lines;
      summary.per_file.push({
        path: p,
        status: 'deleted',
        added: 0,
        removed: lines,
        hash_before: hashA,
        hash_after: null,
      });
      hunkChunks.push(renderUnified(p, a, ''));
    } else if (hashA !== hashB) {
      const { added, removed, hunks } = linewiseDiff(a, b);
      summary.files_changed += 1;
      summary.lines_added += added;
      summary.lines_removed += removed;
      summary.per_file.push({
        path: p,
        status: 'modified',
        added,
        removed,
        hash_before: hashA,
        hash_after: hashB,
        hunks,
      });
      hunkChunks.push(renderUnified(p, a, b));
    } else {
      summary.per_file.push({
        path: p,
        status: 'unchanged',
        added: 0,
        removed: 0,
        hash_before: hashA,
        hash_after: hashB,
      });
    }
  }

  summary.unified_diff = hunkChunks.join('\n');
  return summary;
}

/**
 * Cheap line-wise diff. We don't need an LCS — for the evaluator, we just
 * need an honest add/remove count + a readable unified diff. Use a basic
 * "two-pointer + common-prefix/suffix trim" approach that's correct on
 * the common case (most edits are small, contiguous).
 *
 * For very different files this falls back to "remove all → add all" which
 * inflates the count, but inflation cuts the score down, not up — safe.
 */
function linewiseDiff(beforeStr, afterStr) {
  const a = beforeStr.split('\n');
  const b = afterStr.split('\n');

  // Trim common prefix
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  // Trim common suffix
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1;

  const removed = Math.max(0, a.length - prefix - suffix);
  const added = Math.max(0, b.length - prefix - suffix);

  // Build a compact hunk (everything between prefix and suffix)
  const removedLines = a.slice(prefix, a.length - suffix);
  const addedLines = b.slice(prefix, b.length - suffix);
  const hunkLines = [
    ...removedLines.map((l) => `- ${l}`),
    ...addedLines.map((l) => `+ ${l}`),
  ];
  return { added, removed, hunks: hunkLines.join('\n') };
}

function renderUnified(path, before, after) {
  // Minimal unified-diff render. Not strictly valid `diff -u` output but
  // close enough that the LLM groks it.
  const aLines = before === '' ? [] : before.split('\n');
  const bLines = after === '' ? [] : after.split('\n');
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${aLines.length} +1,${bLines.length} @@`,
    ...aLines.map((l) => `- ${l}`),
    ...bLines.map((l) => `+ ${l}`),
  ].join('\n');
}

function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

module.exports = { diffTrees };
