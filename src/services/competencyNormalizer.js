/**
 * Competency name normalizer — keeps DiagnosticQuestionBank from fragmenting
 * across users who naturally express the same concept differently.
 *
 * Two layers:
 *   1. Cheap normalization: lowercase, trim, strip punctuation, collapse whitespace
 *   2. Alias dictionary lookup
 *
 * A future v2 will add embedding-similarity for unmatched names; for now,
 * the dictionary is the only smart resolution.
 */

// Manually curated aliases. Add new entries as new domains roll out.
// Keys are post-cheap-normalize input; values are the canonical name.
const aliasDictionary = {
  // Database / SQL
  'sql joins': 'database joins',
  'joins': 'database joins',
  'database joins': 'database joins',
  // Product / PM
  'product market fit': 'product-market fit',
  'pmf': 'product-market fit',
  'product-market fit': 'product-market fit',
  // Stats / ML
  'bayes theorem': 'bayes',
  'bayes rule': 'bayes',
  'conditional probability': 'bayes',
  // System Design
  'system design fundamentals': 'system design',
  'sys design': 'system design',
  // Add more as we encounter them in production
};

function _cheapNormalize(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')   // strip punctuation except hyphens
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
}

function normalize(input) {
  const cheap = _cheapNormalize(input);
  if (!cheap) return '';
  return aliasDictionary[cheap] || cheap;
}

module.exports = {
  normalize,
  _internal: { _cheapNormalize, aliasDictionary },
};
