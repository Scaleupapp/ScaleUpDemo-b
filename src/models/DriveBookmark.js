const mongoose = require('mongoose');
const DriveBookmarkSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',           required: true, index: true },
  driveId:   { type: mongoose.Schema.Types.ObjectId, ref: 'PlacementDrive', required: true, index: true },
  createdAt: { type: Date, default: Date.now },
});
DriveBookmarkSchema.index({ userId: 1, driveId: 1 }, { unique: true });
module.exports = mongoose.models.DriveBookmark || mongoose.model('DriveBookmark', DriveBookmarkSchema);
