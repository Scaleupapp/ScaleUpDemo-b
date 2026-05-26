'use strict';

const crypto = require('crypto');

const CANONICAL_FIELDS = [
  'brief',
  'role_track',
  'language',
  'difficulty',
  'drill_subtype',
  'reference_solution',
];

/**
 * Stable JSON stringify — sort object keys at every level so the same content
 * always serializes the same way regardless of insertion order.
 *
 * @param {*} obj
 * @returns {*}
 */
function canonicalize(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = canonicalize(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}

/**
 * Compute a SHA-256 content hash for an ArtifactBundle payload.
 * Only the 6 CANONICAL_FIELDS contribute — all other fields are ignored —
 * making the hash stable for deduplication regardless of metadata changes.
 *
 * @param {object} bundle
 * @returns {string} 64-char lowercase hex SHA-256 digest
 */
function computeContentHash(bundle) {
  const subset = {};
  for (const field of CANONICAL_FIELDS) {
    if (bundle[field] !== undefined) subset[field] = bundle[field];
  }
  const canonical = JSON.stringify(canonicalize(subset));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = { computeContentHash, CANONICAL_FIELDS };
