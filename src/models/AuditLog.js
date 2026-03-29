const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  action: { type: String, required: true, index: true },
  category: {
    type: String,
    enum: ['auth', 'profile', 'data', 'content', 'security', 'admin', 'consent'],
    required: true,
  },
  details: { type: mongoose.Schema.Types.Mixed },
  ip: { type: String },
  userAgent: { type: String },
  timestamp: { type: Date, default: Date.now, index: true },
}, { timestamps: false });

// Auto-expire audit logs after 2 years (730 days)
auditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 730 * 24 * 60 * 60 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
