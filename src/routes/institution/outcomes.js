'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const router = express.Router();
router._deps = null;
function getService(deps) { return (deps && deps.outcomeService) || require('../../services/institution/outcomeService'); }
const WRITE = requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator');

router.post('/cohorts/:cohortId/offers', institutionAuth, WRITE, async (req, res) => {
  try { const o = await getService(router._deps).createOffer(institutionScope(req), req.params.cohortId, req.body || {});
    return res.status(201).json({ success: true, data: o });
  } catch (err) { if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid offer data.' });
    console.error('[institution/outcomes:create]', err.message); return res.status(500).json({ success: false, message: 'Could not create offer.' }); }
});
router.get('/cohorts/:cohortId/offers', institutionAuth, async (req, res) => {
  try { const data = await getService(router._deps).listOffers(institutionScope(req), req.params.cohortId);
    return res.status(200).json({ success: true, data });
  } catch (err) { console.error('[institution/outcomes:list]', err.message); return res.status(500).json({ success: false, message: 'Could not list offers.' }); }
});
router.patch('/cohorts/:cohortId/offers/:offerId', institutionAuth, WRITE, async (req, res) => {
  try { const o = await getService(router._deps).updateOffer(institutionScope(req), req.params.cohortId, req.params.offerId, req.body || {});
    return res.status(200).json({ success: true, data: o });
  } catch (err) { if (err.message === 'OFFER_NOT_FOUND') return res.status(404).json({ success: false, message: 'Offer not found.' });
    if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid offer data.' });
    console.error('[institution/outcomes:update]', err.message); return res.status(500).json({ success: false, message: 'Could not update offer.' }); }
});
router.delete('/cohorts/:cohortId/offers/:offerId', institutionAuth, WRITE, async (req, res) => {
  try { await getService(router._deps).deleteOffer(institutionScope(req), req.params.cohortId, req.params.offerId);
    return res.status(200).json({ success: true });
  } catch (err) { if (err.message === 'OFFER_NOT_FOUND') return res.status(404).json({ success: false, message: 'Offer not found.' });
    console.error('[institution/outcomes:delete]', err.message); return res.status(500).json({ success: false, message: 'Could not delete offer.' }); }
});
router.post('/cohorts/:cohortId/offers/import', institutionAuth, WRITE, async (req, res) => {
  try { const result = await getService(router._deps).importOffers(institutionScope(req), req.params.cohortId, (req.body || {}).rows);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { console.error('[institution/outcomes:import]', err.message); return res.status(500).json({ success: false, message: 'Could not import offers.' }); }
});
router.get('/cohorts/:cohortId/outcomes', institutionAuth, async (req, res) => {
  try { const data = await getService(router._deps).cohortOutcomes(institutionScope(req), req.params.cohortId);
    return res.status(200).json({ success: true, data });
  } catch (err) { console.error('[institution/outcomes:cohort]', err.message); return res.status(500).json({ success: false, message: 'Could not get cohort outcomes.' }); }
});
router.get('/outcomes', institutionAuth, async (req, res) => {
  try { const data = await getService(router._deps).institutionOutcomes(institutionScope(req));
    return res.status(200).json({ success: true, data });
  } catch (err) { console.error('[institution/outcomes:institution]', err.message); return res.status(500).json({ success: false, message: 'Could not get institution outcomes.' }); }
});
function csvEscape(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; }
router.get('/cohorts/:cohortId/report.csv', institutionAuth, async (req, res) => {
  try {
    const { header, rows } = await getService(router._deps).buildReportRows(institutionScope(req), req.params.cohortId);
    const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="placement-report-${req.params.cohortId}.csv"`);
    return res.status(200).send(csv);
  } catch (err) { console.error('[institution/report.csv]', err.message); return res.status(500).json({ success: false, message: 'Could not build report.' }); }
});
module.exports = router;
