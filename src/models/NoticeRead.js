const mongoose = require('mongoose');
const NoticeReadSchema = new mongoose.Schema({
  noticeId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionNotice', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  readAt: { type: Date, default: Date.now },
});
NoticeReadSchema.index({ noticeId: 1, userId: 1 }, { unique: true });
module.exports = mongoose.models.NoticeRead || mongoose.model('NoticeRead', NoticeReadSchema);
