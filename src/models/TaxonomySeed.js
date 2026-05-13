const mongoose = require('mongoose');

/**
 * Pre-populated taxonomy entries — covers the 95% common case of objectives.
 *
 * Three entity types: company | exam | skill | role. Each has minimal
 * shared metadata + entity-specific fields under `data`. We use a single
 * collection so the iOS objective-setup typeahead can search across all
 * entity types with one query.
 *
 * The existing `TopicTaxonomy` model (LLM-extended) is unchanged — that's
 * the per-objective topic tree. This is the lookup catalog for picking an
 * objective in the first place.
 */
const taxonomySeedSchema = new mongoose.Schema({
  type: { type: String, enum: ['company', 'exam', 'skill', 'role'], required: true, index: true },
  slug: { type: String, required: true, index: true },
  name: { type: String, required: true, index: true },
  // searchable lowercase variant for typeahead
  nameLower: { type: String, required: true, index: true },
  // Entity-specific payload — kept flexible so we can add fields without migration
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  popularity: { type: Number, default: 0 },          // tunable ordering for typeahead
  isActive: { type: Boolean, default: true, index: true },
  source: { type: String, default: 'seed' },          // seed | admin | llm_extension
}, { timestamps: true });

taxonomySeedSchema.index({ type: 1, nameLower: 'text' });
taxonomySeedSchema.index({ type: 1, isActive: 1, popularity: -1 });
taxonomySeedSchema.index({ slug: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('TaxonomySeed', taxonomySeedSchema);
