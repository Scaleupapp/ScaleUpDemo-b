'use strict';
const SHELF_FIELDS = ['title', 'order'];
const ITEM_FIELDS = ['type', 'title', 'url', 's3Key', 'fileName', 'mime', 'note', 'order'];
function pick(fields, body = {}) { const o = {}; for (const k of fields) if (body[k] !== undefined) o[k] = body[k]; return o; }
function models(deps) {
  return {
    Shelf: (deps && deps.Shelf) || require('../../models/Shelf'),
    ShelfItem: (deps && deps.ShelfItem) || require('../../models/ShelfItem'),
  };
}
async function createShelf(scope, cohortId, body, deps) {
  const { Shelf } = models(deps);
  return Shelf.create({ ...scope, cohortId, ...pick(SHELF_FIELDS, body) });
}
async function listShelves(scope, cohortId, deps) {
  const { Shelf, ShelfItem } = models(deps);
  const sq = Shelf.find({ ...scope, cohortId }).sort({ order: 1, createdAt: 1 }).limit(200);
  const shelves = typeof sq.lean === 'function' ? await sq.lean() : await sq;
  const ids = shelves.map((s) => s._id);
  const iq = ShelfItem.find({ shelfId: { $in: ids } }).sort({ order: 1, createdAt: 1 });
  const items = typeof iq.lean === 'function' ? await iq.lean() : await iq;
  const byShelf = {}; for (const it of items) { (byShelf[String(it.shelfId)] ||= []).push(it); }
  return shelves.map((s) => ({ ...s, items: byShelf[String(s._id)] || [] }));
}
async function updateShelf(scope, cohortId, shelfId, body, deps) {
  const { Shelf } = models(deps);
  const s = await Shelf.findOneAndUpdate({ ...scope, cohortId, _id: shelfId }, { $set: pick(SHELF_FIELDS, body) }, { new: true });
  if (!s) throw new Error('SHELF_NOT_FOUND'); return s;
}
async function deleteShelf(scope, cohortId, shelfId, deps) {
  const { Shelf, ShelfItem } = models(deps);
  const s = await Shelf.findOneAndDelete({ ...scope, cohortId, _id: shelfId });
  if (!s) throw new Error('SHELF_NOT_FOUND');
  try { await ShelfItem.deleteMany({ shelfId }); } catch (e) { /* best-effort */ }
  return s;
}
async function assertShelf(scope, cohortId, shelfId, deps) {
  const { Shelf } = models(deps);
  const s = await Shelf.findOne({ ...scope, cohortId, _id: shelfId });
  if (!s) throw new Error('SHELF_NOT_FOUND');
  return s;
}
async function addItem(scope, cohortId, shelfId, body, deps) {
  const { ShelfItem } = models(deps);
  await assertShelf(scope, cohortId, shelfId, deps);
  return ShelfItem.create({ shelfId, ...pick(ITEM_FIELDS, body) });
}
async function updateItem(scope, cohortId, shelfId, itemId, body, deps) {
  const { ShelfItem } = models(deps);
  await assertShelf(scope, cohortId, shelfId, deps);
  const it = await ShelfItem.findOneAndUpdate({ shelfId, _id: itemId }, { $set: pick(ITEM_FIELDS, body) }, { new: true });
  if (!it) throw new Error('ITEM_NOT_FOUND'); return it;
}
async function deleteItem(scope, cohortId, shelfId, itemId, deps) {
  const { ShelfItem } = models(deps);
  await assertShelf(scope, cohortId, shelfId, deps);
  const it = await ShelfItem.findOneAndDelete({ shelfId, _id: itemId });
  if (!it) throw new Error('ITEM_NOT_FOUND'); return it;
}
module.exports = { createShelf, listShelves, updateShelf, deleteShelf, addItem, updateItem, deleteItem };
