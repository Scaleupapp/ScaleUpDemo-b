'use strict';
const NOTICE_FIELDS = ['title', 'body', 'pinned', 'link', 'attachment'];
function pick(body = {}) { const o = {}; for (const k of NOTICE_FIELDS) if (body[k] !== undefined) o[k] = body[k]; return o; }
function models(deps) {
  return {
    Notice: (deps && deps.InstitutionNotice) || require('../../models/InstitutionNotice'),
    NoticeRead: (deps && deps.NoticeRead) || require('../../models/NoticeRead'),
    Enrollment: (deps && deps.InstitutionEnrollment) || require('../../models/InstitutionEnrollment'),
  };
}
async function createNotice(scope, cohortId, body, deps) {
  const { Notice } = models(deps);
  return Notice.create({ ...scope, cohortId, ...pick(body) });
}
async function listNotices(scope, cohortId, deps) {
  const { Notice, NoticeRead, Enrollment } = models(deps);
  const nq = Notice.find({ ...scope, cohortId }).sort({ pinned: -1, createdAt: -1 }).limit(500);
  const notices = typeof nq.lean === 'function' ? await nq.lean() : await nq;
  const ids = notices.map((n) => n._id);
  const reads = ids.length ? await NoticeRead.aggregate([{ $match: { noticeId: { $in: ids } } }, { $group: { _id: '$noticeId', c: { $sum: 1 } } }]) : [];
  const readByNotice = {}; for (const r of reads) readByNotice[String(r._id)] = r.c;
  const total = await Enrollment.countDocuments({ ...scope, cohortId });
  return { notices: notices.map((n) => ({ ...n, readCount: readByNotice[String(n._id)] || 0 })), total };
}
async function updateNotice(scope, cohortId, noticeId, body, deps) {
  const { Notice } = models(deps);
  const n = await Notice.findOneAndUpdate({ ...scope, cohortId, _id: noticeId }, { $set: pick(body) }, { new: true });
  if (!n) throw new Error('NOTICE_NOT_FOUND'); return n;
}
async function deleteNotice(scope, cohortId, noticeId, deps) {
  const { Notice, NoticeRead } = models(deps);
  const n = await Notice.findOneAndDelete({ ...scope, cohortId, _id: noticeId });
  if (!n) throw new Error('NOTICE_NOT_FOUND');
  try { await NoticeRead.deleteMany({ noticeId }); } catch (e) { /* best-effort cleanup */ }
  return n;
}
module.exports = { createNotice, listNotices, updateNotice, deleteNotice };
