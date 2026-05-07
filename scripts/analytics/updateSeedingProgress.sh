#!/usr/bin/env bash
# updateSeedingProgress.sh — query MongoDB for current seeding counts.
#
# Emits a JSON object with current taxonomy, question, and company counts.
# Use the output to manually update docs/superpowers/research/seedingProgress.md.
#
# To automate the patch step: pipe the JSON into a sed/jq script that replaces
# the "—" placeholders in the markdown tables. Not automated here because the
# table format may evolve across Wave 1/2/3.
#
# Usage:
#   MONGODB_URI="mongodb+srv://..." bash scripts/analytics/updateSeedingProgress.sh
#   # Or set MONGODB_URI in your .env and source it first.

set -euo pipefail

MONGODB_URI="${MONGODB_URI:-}"

if [ -z "$MONGODB_URI" ]; then
  # Try loading from .env in repo root
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
  if [ -f "$REPO_ROOT/.env" ]; then
    # shellcheck disable=SC1091
    export $(grep -v '^#' "$REPO_ROOT/.env" | xargs)
  fi
fi

if [ -z "${MONGODB_URI:-}" ]; then
  echo "Error: MONGODB_URI is not set." >&2
  echo "Set it via env var or place it in .env at the repo root." >&2
  exit 1
fi

echo "Querying MongoDB for seeding counts..."

node --input-type=module <<'EOF'
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
await mongoose.connect(uri);
const db = mongoose.connection.db;

const taxonomyCount = await db.collection('topictaxonomies').countDocuments();
const questionCount = await db.collection('diagnosticquestionbanks').countDocuments();
const companyCount  = await db.collection('companyprofiles').countDocuments();

const autoVerified  = await db.collection('diagnosticquestionbanks')
  .countDocuments({ verificationStatus: 'auto_verified' });
const flagged       = await db.collection('diagnosticquestionbanks')
  .countDocuments({ verificationStatus: 'flagged_for_review' });
const pending       = await db.collection('diagnosticquestionbanks')
  .countDocuments({ verificationStatus: 'pending' });

const result = {
  taxonomies: taxonomyCount,
  questions: {
    total: questionCount,
    auto_verified: autoVerified,
    flagged_for_review: flagged,
    pending,
  },
  companies: companyCount,
  queriedAt: new Date().toISOString(),
};

console.log(JSON.stringify(result, null, 2));

// Hint for automation
console.error('\n[hint] Paste the counts above into docs/superpowers/research/seedingProgress.md');
console.error('[hint] To automate: pipe JSON into a script that patches the markdown tables.');

await mongoose.disconnect();
EOF
