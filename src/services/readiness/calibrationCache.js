'use strict';
// Process-level cache of CalibrationModels keyed by archetype, so the sync
// getEffectiveTarget can read calibration without an await. Refreshed lazily
// (TTL) and after the recompute job.
const TTL_MS = parseInt(process.env.CALIB_CACHE_TTL_MS || String(10 * 60 * 1000), 10);
let _byArchetype = {};
let _loadedAt = 0;

async function refresh() {
  try {
    const CalibrationModel = require('../../models/CalibrationModel');
    const docs = await CalibrationModel.find({}).lean();
    _byArchetype = docs.reduce((m, d) => { m[d.archetype] = d; return m; }, {});
    _loadedAt = Date.now();
  } catch (e) { /* leave stale cache on error */ }
}

function get(archetype) {
  // Best-effort lazy refresh; never blocks (fire-and-forget when stale).
  if (Date.now() - _loadedAt > TTL_MS) { _loadedAt = Date.now(); refresh().catch(() => {}); }
  return _byArchetype[archetype] || null;
}

function _seed(map) { _byArchetype = map; _loadedAt = Date.now(); } // tests only

module.exports = { refresh, get, _seed };
