/**
 * v2 Taxonomy search — powers the iOS objective-setup typeahead.
 *
 *   GET /api/v2/taxonomy/search?q=goog&type=company&limit=10
 *   GET /api/v2/taxonomy/popular?type=company&limit=6
 *   GET /api/v2/taxonomy/:slug
 */
const express = require('express');
const auth = require('../../middleware/auth');
const TaxonomySeed = require('../../models/TaxonomySeed');

const router = express.Router();

router.get('/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const type = req.query.type;
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 25);

    if (q.length < 1) {
      return res.json({ success: true, data: [] });
    }

    const filter = {
      isActive: true,
      nameLower: { $regex: `${escapeRegex(q)}`, $options: 'i' },
    };
    if (type) filter.type = type;

    const results = await TaxonomySeed.find(filter)
      .sort({ popularity: -1, name: 1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      data: results.map(r => ({
        slug: r.slug,
        type: r.type,
        name: r.name,
        data: r.data,
      })),
    });
  } catch (err) {
    console.error('[v2/taxonomy/search] error', err);
    return res.status(500).json({ success: false, message: 'Search failed' });
  }
});

router.get('/popular', auth, async (req, res) => {
  try {
    const type = req.query.type;
    const limit = Math.min(parseInt(req.query.limit || '6', 10), 20);

    const filter = { isActive: true };
    if (type) filter.type = type;

    const results = await TaxonomySeed.find(filter)
      .sort({ popularity: -1, name: 1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      data: results.map(r => ({
        slug: r.slug,
        type: r.type,
        name: r.name,
        data: r.data,
      })),
    });
  } catch (err) {
    console.error('[v2/taxonomy/popular] error', err);
    return res.status(500).json({ success: false, message: 'Popular fetch failed' });
  }
});

router.get('/:slug', auth, async (req, res) => {
  try {
    const entries = await TaxonomySeed.find({ slug: req.params.slug, isActive: true }).lean();
    if (entries.length === 0) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    return res.json({
      success: true,
      data: entries.map(r => ({ slug: r.slug, type: r.type, name: r.name, data: r.data })),
    });
  } catch (err) {
    console.error('[v2/taxonomy/:slug] error', err);
    return res.status(500).json({ success: false, message: 'Lookup failed' });
  }
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
