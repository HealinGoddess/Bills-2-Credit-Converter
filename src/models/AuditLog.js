const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, index: true },
    userId: { type: String, index: true },
    statementId: { type: String, index: true },
    details: { type: mongoose.Schema.Types.Mixed },
  },
  { collection: 'audit_logs', timestamps: { createdAt: true, updatedAt: false } },
);

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
