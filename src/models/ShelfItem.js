const mongoose = require('mongoose');
const ShelfItemSchema = new mongoose.Schema({
  shelfId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shelf', required: true, index: true },
  type: { type: String, enum: ['link', 'file'], required: true },
  title: { type: String, required: true, trim: true },
  url: { type: String, trim: true },        // type=link
  s3Key: { type: String },                  // type=file
  fileName: { type: String, trim: true },
  mime: { type: String, trim: true },
  note: { type: String, trim: true },
  order: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });
ShelfItemSchema.index({ shelfId: 1, order: 1 });
module.exports = mongoose.models.ShelfItem || mongoose.model('ShelfItem', ShelfItemSchema);
