/**
 * v2 Objective routes.
 *
 * What v2 adds that v1 doesn't have:
 *   POST /api/v2/objective/parse         — free text → structured + validated objective
 *   GET  /api/v2/objective/suggest       — catalog typeahead for objective-setup
 *   GET  /api/v2/objective/popular       — popular catalog entries by type
 *   POST /api/v2/objective/required-time — compute hours/week required (not asked)
 *
 * v1 objective CRUD is still at /api/v1/objectives — unchanged.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const { computeRequiredTime } = require('../../services/v2/requiredTimeService');
const { parseObjective } = require('../../services/v2/objectiveParserService');
const ObjectiveCatalog = require('../../models/ObjectiveCatalog');

const router = express.Router();

/**
 * POST /api/v2/objective/parse
 * Body: { text: "SDE placement at Google" }
 * Returns the validation funnel result: status (green/long_tail/rejected),
 * structured objectiveType + specifics, catalog matches, and a user-facing
 * message. Caller ALWAYS shows a confirmation gate before saving.
 */
router.post('/parse', auth, async (req, res) => {
  const text = (req.body && req.body.text || '').toString();
  if (!text.trim()) {
    return res.status(400).json({ success: false, message: 'text is required' });
  }
  try {
    const result = await parseObjective(text);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[v2/objective/parse] error', err);
    return res.status(500).json({ success: false, message: 'Parse failed' });
  }
});

/**
 * GET /api/v2/objective/suggest?q=goog&type=company&limit=10
 * Typeahead against the curated ObjectiveCatalog. `type` optional.
 */
router.get('/suggest', auth, async (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const type = req.query.type;
  const limit = Math.min(parseInt(req.query.limit || '10', 10) || 10, 25);

  if (q.length < 1) return res.json({ success: true, data: [] });

  try {
    const filter = {
      isActive: true,
      $or: [
        { nameLower: { $regex: escapeRegex(q), $options: 'i' } },
        { aliasesLower: { $regex: escapeRegex(q), $options: 'i' } },
      ],
    };
    if (type) filter.type = type;

    const results = await ObjectiveCatalog.find(filter)
      .sort({ popularity: -1, name: 1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      data: results.map(shapeCatalogEntry),
    });
  } catch (err) {
    console.error('[v2/objective/suggest] error', err);
    return res.status(500).json({ success: false, message: 'Suggest failed' });
  }
});

/**
 * GET /api/v2/objective/popular?type=role&limit=8
 * Popular curated entries — powers the "Popular goals" list (no hardcoding).
 */
router.get('/popular', auth, async (req, res) => {
  const type = req.query.type;
  const limit = Math.min(parseInt(req.query.limit || '8', 10) || 8, 30);
  try {
    const filter = { isActive: true };
    if (type) filter.type = type;
    const results = await ObjectiveCatalog.find(filter)
      .sort({ popularity: -1, name: 1 })
      .limit(limit)
      .lean();
    return res.json({ success: true, data: results.map(shapeCatalogEntry) });
  } catch (err) {
    console.error('[v2/objective/popular] error', err);
    return res.status(500).json({ success: false, message: 'Popular fetch failed' });
  }
});

function shapeCatalogEntry(e) {
  return {
    type: e.type,
    name: e.name,
    canonicalSlug: e.canonicalSlug,
    mapsToObjectiveType: e.mapsToObjectiveType,
    category: e.category || null,
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * POST /api/v2/objective/required-time
 * Body: { objectiveType, specifics, timeline, currentLevel }
 * Returns: { requiredHoursPerWeek, paths: { commit, lessTime, moreTime }, warnings, ... }
 *
 * No DB write — pure computation. Client uses this during onboarding to surface
 * the honest reality-check screen before saving the objective.
 */
router.post('/required-time', auth, (req, res) => {
  const { objectiveType, specifics, timeline, currentLevel } = req.body || {};

  if (!objectiveType || !timeline) {
    return res.status(400).json({
      success: false,
      message: 'objectiveType and timeline are required',
    });
  }

  try {
    const result = computeRequiredTime({
      objectiveType,
      specifics: specifics || {},
      timeline,
      currentLevel: currentLevel || 'beginner',
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[v2/objective/required-time] error', err);
    return res.status(500).json({ success: false, message: 'Computation failed' });
  }
});

module.exports = router;
