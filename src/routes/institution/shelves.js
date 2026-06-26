'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const router = express.Router();
router._deps = null;
function getService(deps) { return (deps && deps.shelfService) || require('../../services/institution/shelfService'); }
const WRITE = requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator');

// POST /cohorts/:cohortId/shelves — create a shelf (write roles only)
router.post('/cohorts/:cohortId/shelves', institutionAuth, WRITE, async (req, res) => {
  try {
    const shelf = await getService(router._deps).createShelf(institutionScope(req), req.params.cohortId, req.body || {});
    return res.status(201).json({ success: true, data: shelf });
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid shelf data.' });
    console.error('[institution/shelves:create]', err.message); return res.status(500).json({ success: false, message: 'Could not create shelf.' });
  }
});

// GET /cohorts/:cohortId/shelves — list shelves with items (any institution role)
router.get('/cohorts/:cohortId/shelves', institutionAuth, async (req, res) => {
  try {
    const data = await getService(router._deps).listShelves(institutionScope(req), req.params.cohortId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[institution/shelves:list]', err.message); return res.status(500).json({ success: false, message: 'Could not list shelves.' });
  }
});

// PATCH /cohorts/:cohortId/shelves/:shelfId — update a shelf
router.patch('/cohorts/:cohortId/shelves/:shelfId', institutionAuth, WRITE, async (req, res) => {
  try {
    const shelf = await getService(router._deps).updateShelf(institutionScope(req), req.params.cohortId, req.params.shelfId, req.body || {});
    return res.status(200).json({ success: true, data: shelf });
  } catch (err) {
    if (err.message === 'SHELF_NOT_FOUND') return res.status(404).json({ success: false, message: 'Shelf not found.' });
    if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid shelf data.' });
    console.error('[institution/shelves:update]', err.message); return res.status(500).json({ success: false, message: 'Could not update shelf.' });
  }
});

// DELETE /cohorts/:cohortId/shelves/:shelfId — delete a shelf (and its items)
router.delete('/cohorts/:cohortId/shelves/:shelfId', institutionAuth, WRITE, async (req, res) => {
  try {
    await getService(router._deps).deleteShelf(institutionScope(req), req.params.cohortId, req.params.shelfId);
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err.message === 'SHELF_NOT_FOUND') return res.status(404).json({ success: false, message: 'Shelf not found.' });
    console.error('[institution/shelves:delete]', err.message); return res.status(500).json({ success: false, message: 'Could not delete shelf.' });
  }
});

// POST /cohorts/:cohortId/shelves/:shelfId/items — add an item to a shelf
router.post('/cohorts/:cohortId/shelves/:shelfId/items', institutionAuth, WRITE, async (req, res) => {
  try {
    const item = await getService(router._deps).addItem(institutionScope(req), req.params.cohortId, req.params.shelfId, req.body || {});
    return res.status(201).json({ success: true, data: item });
  } catch (err) {
    if (err.message === 'SHELF_NOT_FOUND') return res.status(404).json({ success: false, message: 'Shelf not found.' });
    if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid item data.' });
    console.error('[institution/shelves:addItem]', err.message); return res.status(500).json({ success: false, message: 'Could not add item.' });
  }
});

// PATCH /cohorts/:cohortId/shelves/:shelfId/items/:itemId — update an item
router.patch('/cohorts/:cohortId/shelves/:shelfId/items/:itemId', institutionAuth, WRITE, async (req, res) => {
  try {
    const item = await getService(router._deps).updateItem(institutionScope(req), req.params.cohortId, req.params.shelfId, req.params.itemId, req.body || {});
    return res.status(200).json({ success: true, data: item });
  } catch (err) {
    if (err.message === 'SHELF_NOT_FOUND' || err.message === 'ITEM_NOT_FOUND') return res.status(404).json({ success: false, message: 'Not found.' });
    if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid item data.' });
    console.error('[institution/shelves:updateItem]', err.message); return res.status(500).json({ success: false, message: 'Could not update item.' });
  }
});

// DELETE /cohorts/:cohortId/shelves/:shelfId/items/:itemId — delete an item
router.delete('/cohorts/:cohortId/shelves/:shelfId/items/:itemId', institutionAuth, WRITE, async (req, res) => {
  try {
    await getService(router._deps).deleteItem(institutionScope(req), req.params.cohortId, req.params.shelfId, req.params.itemId);
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err.message === 'SHELF_NOT_FOUND' || err.message === 'ITEM_NOT_FOUND') return res.status(404).json({ success: false, message: 'Not found.' });
    console.error('[institution/shelves:deleteItem]', err.message); return res.status(500).json({ success: false, message: 'Could not delete item.' });
  }
});

module.exports = router;
