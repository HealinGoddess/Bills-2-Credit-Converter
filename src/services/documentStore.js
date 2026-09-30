const StatementDocument = require('../models/StatementDocument');
const AuditLog = require('../models/AuditLog');

function createMongoDocumentStore() {
  return {
    async saveStatementDocument(doc) {
      await StatementDocument.create(doc);
    },
    async audit(event, { userId, statementId, details } = {}) {
      await AuditLog.create({ event, userId, statementId, details });
    },
  };
}

module.exports = { createMongoDocumentStore };
