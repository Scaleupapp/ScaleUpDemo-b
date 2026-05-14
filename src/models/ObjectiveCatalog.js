const mongoose = require('mongoose');

/**
 * ObjectiveCatalog — the thin "spell-check dictionary" for objective entry.
 *
 * Purpose: a lightweight, searchable index of the roles / exams / skills /
 * companies / college-prep targets ScaleUp officially supports. It powers:
 *   1. the objective-setup typeahead (GET /api/v2/objective/suggest)
 *   2. validation in the NLU parser (cross-check parsed input against this)
 *
 * It deliberately does NOT duplicate:
 *   - TopicTaxonomy  → that holds the topic *trees* (keyed by targetKey)
 *   - CompanyProfile → that holds company *interview intelligence*
 * This collection only holds NAMES + ALIASES + TYPE. It's the index that
 * points at those, not a copy of them.
 *
 * Population: insert-only idempotent import (scripts/import-objective-catalog.js)
 * from data/objective-catalog.json. The NLU parser may also write
 * source:'llm-discovered' entries when it confidently identifies a real
 * target not yet curated — those are content-team review candidates.
 */
const objectiveCatalogSchema = new mongoose.Schema({
  // role | exam | skill | company | college_prep
  type: {
    type: String,
    enum: ['role', 'exam', 'skill', 'company', 'college_prep'],
    required: true,
    index: true,
  },
  name: { type: String, required: true },
  // lowercase, searchable
  nameLower: { type: String, required: true, index: true },
  // stable kebab-case key — unique per (type, canonicalSlug)
  canonicalSlug: { type: String, required: true },
  // alternate spellings / abbreviations the typeahead + parser should match
  // e.g. ["goog", "google india"] for Google; ["sde", "swe"] for SDE
  aliases: { type: [String], default: [] },
  aliasesLower: { type: [String], default: [], index: true },

  // which v1 objectiveType this maps to — so the parser can resolve it
  // role        → interview_preparation
  // exam        → exam_preparation
  // skill       → upskilling
  // company     → (modifier on interview_preparation)
  // college_prep→ academic_excellence
  mapsToObjectiveType: {
    type: String,
    enum: [
      'upskilling', 'interview_preparation', 'exam_preparation',
      'career_switch', 'academic_excellence', 'casual_learning', 'networking',
    ],
  },

  // for companies — light grouping for ranking, NOT interview data
  category: { type: String },        // e.g. "big_tech", "indian_startup", "consulting"
  // higher = surfaced first in typeahead
  popularity: { type: Number, default: 50, index: true },

  source: {
    type: String,
    enum: ['curated', 'llm-discovered'],
    default: 'curated',
    index: true,
  },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

objectiveCatalogSchema.index({ type: 1, canonicalSlug: 1 }, { unique: true });
objectiveCatalogSchema.index({ type: 1, isActive: 1, popularity: -1 });
objectiveCatalogSchema.index({ nameLower: 'text', aliasesLower: 'text' });

module.exports = mongoose.model('ObjectiveCatalog', objectiveCatalogSchema);
