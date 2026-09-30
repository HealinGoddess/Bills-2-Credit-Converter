const mongoose = require('mongoose');

const statementDocumentSchema = new mongoose.Schema(
  {
    statementId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    ocrHash: { type: String, required: true, index: true },
    mimeType: { type: String, required: true },
    ocrProvider: { type: String, required: true },
    rawText: { type: String },
    extractedFields: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { collection: 'statement_documents', timestamps: true },
);

module.exports = mongoose.models.StatementDocument
  || mongoose.model('StatementDocument', statementDocumentSchema);
